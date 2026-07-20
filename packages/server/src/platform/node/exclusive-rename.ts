import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { getSystemErrorName } from 'node:util'

type NativeRename = (
  sourceParentFd: number,
  sourceName: string,
  destinationParentFd: number,
  destinationName: string,
  flags: number,
) => number

type NativeSyscall = (number: number, ...args: unknown[]) => number

interface NativeBinding {
  errno: () => number
  rename: NativeRename
}

let bindingPromise: Promise<NativeBinding> | undefined

export async function renameDirectoryNoReplace(source: string, destination: string): Promise<void> {
  const sourceParent = await openDirectory(dirname(source))
  try {
    const destinationParent = await openDirectory(dirname(destination))
    try {
      const binding = await loadBinding()
      const result = binding.rename(
        sourceParent.fd,
        strictBasename(source),
        destinationParent.fd,
        strictBasename(destination),
        process.platform === 'darwin' ? 0x00000004 : 0x00000001,
      )
      if (result !== 0) throw nativeError(binding.errno())
    } finally {
      await destinationParent.close()
    }
  } finally {
    await sourceParent.close()
  }
}

async function openDirectory(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isDirectory()) throw new Error(`Atomic rename parent is not a directory: ${path}`)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function loadBinding(): Promise<NativeBinding> {
  bindingPromise ??= createBinding()
  return bindingPromise
}

async function createBinding(): Promise<NativeBinding> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw unavailableError()
  }
  try {
    const koffi = (await import('koffi')).default
    const library = koffi.load(null)
    let rename: NativeRename
    if (process.platform === 'darwin') {
      rename = library.func(
        'int renameatx_np(int, const char *, int, const char *, unsigned int)',
      ) as NativeRename
    } else {
      try {
        rename = library.func(
          'int renameat2(int, const char *, int, const char *, unsigned int)',
        ) as NativeRename
      } catch (wrapperError) {
        const syscallNumber = linuxRenameat2SyscallNumber()
        if (syscallNumber === undefined) throw wrapperError
        const syscall = library.func('long syscall(long, ...)') as NativeSyscall
        rename = (sourceParentFd, sourceName, destinationParentFd, destinationName, flags) =>
          syscall(
            syscallNumber,
            'int',
            sourceParentFd,
            'const char *',
            sourceName,
            'int',
            destinationParentFd,
            'const char *',
            destinationName,
            'unsigned int',
            flags,
          )
      }
    }
    return { errno: koffi.errno, rename }
  } catch (cause) {
    throw unavailableError(cause)
  }
}

function linuxRenameat2SyscallNumber(): number | undefined {
  const syscallNumbers: Partial<Record<NodeJS.Architecture, number>> = {
    arm64: 276,
    ia32: 353,
    loong64: 276,
    riscv64: 276,
    x64: 316,
  }
  return syscallNumbers[process.arch]
}

function strictBasename(path: string): string {
  const name = basename(path)
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw new Error(`Atomic rename requires a bounded basename: ${path}`)
  }
  return name
}

function nativeError(errno: number): Error {
  let code = 'UNKNOWN'
  try {
    code = getSystemErrorName(-errno)
  } catch {
    // Preserve UNKNOWN when libc reports an errno Node does not recognize.
  }
  return Object.assign(new Error(`Atomic no-replace rename failed with ${code}`), { code })
}

function unavailableError(cause?: unknown): Error {
  return Object.assign(new Error('Atomic no-replace rename is unavailable', { cause }), {
    code: 'ENOSYS',
  })
}

function directoryFlag(): number {
  return 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
}
