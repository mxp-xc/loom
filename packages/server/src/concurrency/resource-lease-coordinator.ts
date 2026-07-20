import lockfile from 'proper-lockfile'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ResourceLeaseMode = 'read' | 'mutation'

export interface ResourceLeaseRequest {
  key: string
  mode: ResourceLeaseMode
}

export interface HeldResourceLease {
  readonly requests: readonly ResourceLeaseRequest[]
  holds(key: string, mode?: ResourceLeaseMode): boolean
}

type Release = () => Promise<void>
type AcquireLock = (key: string) => Promise<Release>

export const RESOURCE_LEASE_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: {
    forever: true,
    factor: 1.2,
    minTimeout: 50,
    maxTimeout: 250,
    randomize: true,
  },
} as const

interface PendingLease<T> {
  requests: ResourceLeaseRequest[]
  keys: Set<string>
  operation: (lease: HeldResourceLease) => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export class ResourceLeaseCoordinator {
  private readonly pending: PendingLease<unknown>[] = []
  private readonly activeKeys = new Set<string>()

  constructor(private readonly acquireLock: AcquireLock = acquireProcessLock) {}

  run<T>(
    requests: readonly ResourceLeaseRequest[],
    operation: (lease: HeldResourceLease) => Promise<T>,
  ): Promise<T> {
    const normalized = normalizeRequests(requests)
    if (normalized.length === 0) throw new Error('At least one resource lease is required')

    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        requests: normalized,
        keys: new Set(normalized.map(({ key }) => key)),
        operation,
        resolve,
        reject,
      } as PendingLease<unknown>)
      this.schedule()
    })
  }

  runRead<T>(keys: readonly string[], operation: (lease: HeldResourceLease) => Promise<T>) {
    return this.run(
      keys.map((key) => ({ key, mode: 'read' })),
      operation,
    )
  }

  runMutation<T>(keys: readonly string[], operation: (lease: HeldResourceLease) => Promise<T>) {
    return this.run(
      keys.map((key) => ({ key, mode: 'mutation' })),
      operation,
    )
  }

  private schedule(): void {
    for (let index = 0; index < this.pending.length;) {
      const candidate = this.pending[index]!
      if (
        intersects(candidate.keys, this.activeKeys) ||
        this.hasEarlierConflict(index, candidate.keys)
      ) {
        index += 1
        continue
      }

      this.pending.splice(index, 1)
      for (const key of candidate.keys) this.activeKeys.add(key)
      void this.execute(candidate)
    }
  }

  private hasEarlierConflict(index: number, keys: Set<string>): boolean {
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (intersects(keys, this.pending[earlier]!.keys)) return true
    }
    return false
  }

  private async execute<T>(pending: PendingLease<T>): Promise<void> {
    const releases: Release[] = []
    let result: T | undefined
    let operationError: unknown
    try {
      for (const { key } of pending.requests) releases.push(await this.acquireLock(key))
      result = await pending.operation(createHeldLease(pending.requests))
    } catch (error) {
      operationError = error
    } finally {
      let releaseError: unknown
      for (const release of releases.reverse()) {
        try {
          await release()
        } catch (error) {
          releaseError = releaseError
            ? new AggregateError([releaseError, error], 'Failed to release resource leases')
            : error
        }
      }
      for (const key of pending.keys) this.activeKeys.delete(key)
      this.schedule()
      if (operationError && releaseError) {
        pending.reject(
          new AggregateError(
            [operationError, releaseError],
            'Resource lease operation and release failed',
          ),
        )
      } else if (operationError) {
        pending.reject(operationError)
      } else if (releaseError) {
        pending.reject(releaseError)
      } else {
        pending.resolve(result as T)
      }
    }
  }
}

const fallbackCoordinators = new WeakMap<object, ResourceLeaseCoordinator>()

export function resourceLeases(
  owner: object,
  coordinator?: ResourceLeaseCoordinator,
): ResourceLeaseCoordinator {
  if (coordinator) return coordinator
  const existing = fallbackCoordinators.get(owner)
  if (existing) return existing
  const fallback = new ResourceLeaseCoordinator(async () => async () => undefined)
  fallbackCoordinators.set(owner, fallback)
  return fallback
}

function normalizeRequests(requests: readonly ResourceLeaseRequest[]): ResourceLeaseRequest[] {
  const byKey = new Map<string, ResourceLeaseMode>()
  for (const request of requests) {
    if (!request.key) throw new Error('Resource lease key cannot be empty')
    const current = byKey.get(request.key)
    if (!current || request.mode === 'mutation') byKey.set(request.key, request.mode)
  }
  return [...byKey]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, mode]) => ({
      key,
      mode,
    }))
}

function createHeldLease(requests: readonly ResourceLeaseRequest[]): HeldResourceLease {
  return {
    requests,
    holds(key, mode = 'read') {
      const request = requests.find((candidate) => candidate.key === key)
      return Boolean(request && (mode === 'read' || request.mode === 'mutation'))
    },
  }
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const key of left) {
    if (right.has(key)) return true
  }
  return false
}

async function acquireProcessLock(key: string): Promise<Release> {
  const lockRoot = join(tmpdir(), `loom-resource-leases-${process.getuid?.() ?? 'user'}`)
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  const lockTarget = join(lockRoot, createHash('sha256').update(key).digest('hex'))
  try {
    await writeFile(lockTarget, '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  return lockfile.lock(lockTarget, RESOURCE_LEASE_LOCK_OPTIONS)
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
