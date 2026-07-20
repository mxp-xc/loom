import type { IFileSystem } from '../ports/fs.js'
import {
  resourceLeases,
  type ResourceLeaseCoordinator,
} from '../concurrency/resource-lease-coordinator.js'
import {
  authorizeRepository,
  RepositoryAccessError,
  revalidateRepositoryAuthorization,
  type RepositoryAuthorization,
} from './repo.js'
import { homeResourceKey } from '../concurrency/resource-keys.js'

interface RepositoryLeaseDeps {
  fs: IFileSystem
  home: string
  leases?: ResourceLeaseCoordinator
}

type RepositoryLeaseMode = 'read' | 'mutation'

export async function canonicalRepositoryHome(
  deps: Pick<RepositoryLeaseDeps, 'fs' | 'home'>,
): Promise<string> {
  try {
    return await homeResourceKey(deps.fs, deps.home)
  } catch (cause) {
    throw new RepositoryAccessError(500, 'repo_unavailable', 'repository is unavailable', {
      cause,
    })
  }
}

export async function withRepositoryLease<T>(
  deps: RepositoryLeaseDeps,
  repo: string,
  mode: RepositoryLeaseMode,
  resourceKeys: (repoPath: string) => readonly string[],
  operation: (repoPath: string) => Promise<T>,
): Promise<T> {
  const authorization = await authorizeRepository(deps.fs, repo, deps.home)
  return runAuthorizedRepositoryLease(deps, authorization, mode, resourceKeys, operation)
}

export async function runAuthorizedRepositoryLease<T>(
  deps: RepositoryLeaseDeps,
  authorization: RepositoryAuthorization,
  mode: RepositoryLeaseMode,
  resourceKeys: (repoPath: string) => readonly string[],
  operation: (repoPath: string) => Promise<T>,
): Promise<T> {
  const leases = resourceLeases(deps, deps.leases)
  const run = mode === 'read' ? leases.runRead.bind(leases) : leases.runMutation.bind(leases)
  return run([...resourceKeys(authorization.path)], async () => {
    await revalidateRepositoryAuthorization(deps.fs, deps.home, authorization)
    return operation(authorization.path)
  })
}
