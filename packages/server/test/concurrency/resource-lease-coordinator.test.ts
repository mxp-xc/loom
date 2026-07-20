import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  RESOURCE_LEASE_LOCK_OPTIONS,
  ResourceLeaseCoordinator,
} from '../../src/concurrency/resource-lease-coordinator.js'
import { bunExecutable, serverPackagePath } from '../helpers/project-path'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function coordinator() {
  return new ResourceLeaseCoordinator(async () => async () => undefined)
}

describe('ResourceLeaseCoordinator', () => {
  it('runs conflicting leases in FIFO order', async () => {
    const leases = coordinator()
    const entered = deferred()
    const release = deferred()
    const events: string[] = []

    const first = leases.runRead(['/repo'], async () => {
      events.push('read:start')
      entered.resolve()
      await release.promise
      events.push('read:end')
    })
    await entered.promise
    const second = leases.runMutation(['/repo'], async () => {
      events.push('mutation')
    })

    release.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['read:start', 'read:end', 'mutation'])
  })

  it('makes readers wait for an active mutation', async () => {
    const leases = coordinator()
    const entered = deferred()
    const release = deferred()
    const events: string[] = []

    const mutation = leases.runMutation(['/repo'], async () => {
      events.push('mutation:start')
      entered.resolve()
      await release.promise
      events.push('mutation:end')
    })
    await entered.promise
    const read = leases.runRead(['/repo'], async () => events.push('read'))

    release.resolve()
    await Promise.all([mutation, read])
    expect(events).toEqual(['mutation:start', 'mutation:end', 'read'])
  })

  it('allows disjoint resource sets to run in parallel', async () => {
    const leases = coordinator()
    const entered = deferred()
    const release = deferred()
    const second = vi.fn()

    const firstRun = leases.runMutation(['/repo-a'], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    await leases.runMutation(['/repo-b'], async () => second())

    expect(second).toHaveBeenCalledOnce()
    release.resolve()
    await firstRun
  })

  it('deduplicates and sorts multi-resource requests before acquisition', async () => {
    const acquired: string[] = []
    const leases = new ResourceLeaseCoordinator(async (key) => {
      acquired.push(key)
      return async () => undefined
    })

    await leases.run(
      [
        { key: '/z', mode: 'read' },
        { key: '/a', mode: 'read' },
        { key: '/z', mode: 'mutation' },
      ],
      async (held) => {
        expect(held.requests).toEqual([
          { key: '/a', mode: 'read' },
          { key: '/z', mode: 'mutation' },
        ])
        expect(held.holds('/z', 'mutation')).toBe(true)
        expect(held.holds('/a', 'mutation')).toBe(false)
      },
    )

    expect(acquired).toEqual(['/a', '/z'])
  })

  it('continues the queue after an operation rejects', async () => {
    const leases = coordinator()
    const failure = new Error('failed')
    const first = leases.runMutation(['/repo'], async () => {
      throw failure
    })
    const second = leases.runMutation(['/repo'], async () => 'completed')

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBe('completed')
  })

  it('reports release failure and still runs the next waiter', async () => {
    const releaseError = new Error('release failed')
    let acquisitions = 0
    const leases = new ResourceLeaseCoordinator(async () => {
      acquisitions += 1
      return acquisitions === 1
        ? async () => {
            throw releaseError
          }
        : async () => undefined
    })

    const first = leases.runMutation(['/repo'], async () => 'first')
    const second = leases.runMutation(['/repo'], async () => 'second')

    await expect(first).rejects.toBe(releaseError)
    await expect(second).resolves.toBe('second')
  })

  it('does not let later multi-resource work bypass an earlier conflicting waiter', async () => {
    const leases = coordinator()
    const entered = deferred()
    const release = deferred()
    const events: string[] = []

    const active = leases.runMutation(['/a'], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const earlier = leases.runMutation(['/a', '/b'], async () => events.push('earlier'))
    const later = leases.runMutation(['/b'], async () => events.push('later'))

    release.resolve()
    await Promise.all([active, earlier, later])
    expect(events).toEqual(['earlier', 'later'])
  })

  it('waits indefinitely for a live cross-process lease', async () => {
    expect(RESOURCE_LEASE_LOCK_OPTIONS.retries).toEqual({
      forever: true,
      factor: 1.2,
      minTimeout: 50,
      maxTimeout: 250,
      randomize: true,
    })
  })

  it('serializes the same logical resource across child processes', async () => {
    const key = resolve('/resource/that/does/not/exist')
    const first = leaseChild(key)
    await first.waitFor('entered')

    const second = leaseChild(key)
    await second.waitFor('requested')
    second.process.stdin.write('check\n')
    await expect(second.waitFor('checked:false')).resolves.toBeUndefined()

    first.process.stdin.write('release\n')
    await first.waitFor('completed')
    await second.waitFor('entered')
    second.process.stdin.write('release\n')
    await second.waitFor('completed')
  })
})

function leaseChild(key: string): {
  process: ChildProcessWithoutNullStreams
  waitFor(line: string): Promise<void>
} {
  const child = spawn(
    bunExecutable(),
    [serverPackagePath('test/concurrency/resource-lease-child.ts'), key],
    {
      cwd: serverPackagePath(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let errorOutput = ''
  let terminalError: Error | null = null
  const waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    for (const [line, listeners] of waiters) {
      if (!output.split('\n').includes(line)) continue
      waiters.delete(line)
      for (const waiter of listeners) waiter.resolve()
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    errorOutput += chunk
  })
  const rejectWaiters = (error: Error) => {
    terminalError = error
    for (const listeners of waiters.values()) {
      for (const waiter of listeners) waiter.reject(error)
    }
    waiters.clear()
  }
  child.once('error', rejectWaiters)
  child.once('exit', (code) => {
    rejectWaiters(new Error(`lease child exited with ${code}: ${output}\n${errorOutput}`))
  })
  return {
    process: child,
    waitFor(line) {
      if (output.split('\n').includes(line)) return Promise.resolve()
      if (terminalError) return Promise.reject(terminalError)
      return new Promise<void>((resolveWaiter, reject) => {
        const listeners = waiters.get(line) ?? []
        listeners.push({ resolve: resolveWaiter, reject })
        waiters.set(line, listeners)
      })
    },
  }
}
