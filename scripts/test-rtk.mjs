import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

const rtk = spawn('rtk', ['pipe', '--filter', 'vitest'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
})
const test = spawn(process.execPath, ['run', 'test', ...process.argv.slice(2), '--reporter=json'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
})

const testOutput = new PassThrough()
testOutput.pipe(rtk.stdin)

let openTestStreams = 2
function closeTestOutput() {
  openTestStreams -= 1
  if (openTestStreams === 0) testOutput.end()
}

test.stdout.pipe(testOutput, { end: false })
test.stderr.pipe(testOutput, { end: false })
test.stdout.on('end', closeTestOutput)
test.stderr.on('end', closeTestOutput)

rtk.stdin.on('error', (err) => {
  if (err.code !== 'EPIPE') console.error('failed to write test output to RTK', err)
})

function waitForProcess(child, name, onSpawnError) {
  let spawnError = false
  return new Promise((resolve) => {
    child.once('error', (err) => {
      spawnError = true
      console.error(`failed to start ${name}`, err)
      onSpawnError()
    })
    child.once('close', (code, signal) => {
      resolve({ code: code ?? 1, signal, spawnError })
    })
  })
}

const [testResult, rtkResult] = await Promise.all([
  waitForProcess(test, 'Bun test process', () => rtk.kill()),
  waitForProcess(rtk, 'RTK', () => test.kill()),
])

if (testResult.spawnError || rtkResult.spawnError) {
  process.exitCode = 127
} else if (testResult.signal || rtkResult.signal) {
  process.exitCode = 1
} else {
  process.exitCode = testResult.code || rtkResult.code
}
