import { isAbsolute, join, relative, resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { setConfigField } from '@loom/core'
import type { IFileSystem } from '../../ports/fs.js'
import {
  ApplicationNotFoundError,
  UnsupportedPlatformError,
  type IExternalOpener,
} from '../../ports/external-opener.js'
import { logger } from '../../lib/logger.js'
import { resolveRepoPath } from '../repo.js'
import { readYaml, writeYaml } from '../repo-config.js'
import { jsonValidator } from '../request-validation.js'

const ExternalApplication = z.enum(['vscode', 'zed', 'system'])
const OpenPathBody = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  application: ExternalApplication,
})
const ResolvePathBody = OpenPathBody.omit({ application: true })
const OpenPathPreferenceBody = z.object({ application: ExternalApplication })
const OPEN_WITH_APPLICATION_FIELD = 'open_with_application'

interface OpenPathRouteDeps {
  fs: IFileSystem
  home: string
  externalOpener: IExternalOpener
}

const openPathLogger = logger.child('open-path-route')

function isWithin(rootPath: string, targetPath: string) {
  const pathFromRoot = relative(rootPath, targetPath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

type ResolvedTarget =
  | { ok: true; path: string; kind: 'file' | 'directory' }
  | {
      ok: false
      status: 400 | 404
      error: 'invalid_repo' | 'invalid_path' | 'not_found'
      message: string
    }

async function resolveTarget(
  deps: Pick<OpenPathRouteDeps, 'fs' | 'home'>,
  repo: string,
  path: string,
): Promise<ResolvedTarget> {
  let repoPath: string
  try {
    repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
  } catch (error) {
    openPathLogger.error('resolve repository for path failed', { err: error, repo, path })
    return { ok: false, status: 400, error: 'invalid_repo', message: '仓库不存在' }
  }

  const targetPath = resolve(repoPath, path)
  if (isAbsolute(path) || !isWithin(repoPath, targetPath)) {
    openPathLogger.warn('rejected path outside repository', { repo, path })
    return {
      ok: false,
      status: 400,
      error: 'invalid_path',
      message: '路径必须位于当前仓库内',
    }
  }
  if (!(await deps.fs.exists(targetPath))) {
    openPathLogger.warn('path target not found', { repo, path })
    return { ok: false, status: 404, error: 'not_found', message: '目标不存在' }
  }

  const [realRepoPath, realTargetPath] = await Promise.all([
    deps.fs.realPath(repoPath),
    deps.fs.realPath(targetPath),
  ])
  if (!isWithin(realRepoPath, realTargetPath)) {
    openPathLogger.warn('rejected symlink target outside repository', {
      repo,
      path,
      realTargetPath,
    })
    return {
      ok: false,
      status: 400,
      error: 'invalid_path',
      message: '路径必须位于当前仓库内',
    }
  }

  return {
    ok: true,
    path: realTargetPath,
    kind: (await deps.fs.isDirectory(realTargetPath)) ? 'directory' : 'file',
  }
}

export function createOpenPathRoutes(deps: OpenPathRouteDeps): Hono {
  const app = new Hono()

  app.get('/open-path/preference', async (c) => {
    const configPath = join(deps.home, '.loom', 'config.yaml')
    try {
      const config = (await readYaml(deps.fs, configPath)) ?? {}
      const stored = ExternalApplication.safeParse(config[OPEN_WITH_APPLICATION_FIELD])
      return c.json({ application: stored.success ? stored.data : 'vscode' })
    } catch (error) {
      openPathLogger.error('read open path preference failed', { err: error, path: configPath })
      return c.json(
        { ok: false, error: 'preference_read_failed', message: '无法读取打开方式偏好' },
        500,
      )
    }
  })

  app.put(
    '/open-path/preference',
    jsonValidator(OpenPathPreferenceBody, {
      error: 'invalid_application',
      message: '打开方式无效',
    }),
    async (c) => {
      const { application } = c.req.valid('json')
      const configPath = join(deps.home, '.loom', 'config.yaml')
      try {
        const config = (await readYaml(deps.fs, configPath)) ?? {}
        const result = setConfigField(config, OPEN_WITH_APPLICATION_FIELD, application)
        if (result.changed) await writeYaml(deps.fs, configPath, result.data)
        return c.json({ ok: true })
      } catch (error) {
        openPathLogger.error('write open path preference failed', {
          err: error,
          path: configPath,
          application,
        })
        return c.json(
          { ok: false, error: 'preference_update_failed', message: '无法保存打开方式偏好' },
          500,
        )
      }
    },
  )

  app.post(
    '/open-path/resolve',
    jsonValidator(ResolvePathBody, { error: 'invalid_request', message: '请求无效' }),
    async (c) => {
      const { repo, path } = c.req.valid('json')
      try {
        const target = await resolveTarget(deps, repo, path)
        if (!target.ok) {
          const body = { ok: false as const, error: target.error, message: target.message }
          return target.status === 404 ? c.json(body, 404) : c.json(body, 400)
        }
        return c.json({ ok: true, path: target.path })
      } catch (error) {
        openPathLogger.error('resolve path failed', { err: error, repo, path })
        return c.json({ ok: false, error: 'resolve_failed', message: '无法解析目标路径' }, 500)
      }
    },
  )

  app.post(
    '/open-path',
    jsonValidator(OpenPathBody, { error: 'invalid_request', message: '请求无效' }),
    async (c) => {
      const { repo, path, application } = c.req.valid('json')
      try {
        const target = await resolveTarget(deps, repo, path)
        if (!target.ok) {
          const body = { ok: false as const, error: target.error, message: target.message }
          return target.status === 404 ? c.json(body, 404) : c.json(body, 400)
        }
        await deps.externalOpener.open(target.path, application, target.kind)
        return c.json({ ok: true })
      } catch (error) {
        openPathLogger.error('open path failed', { err: error, repo, path, application })
        if (error instanceof UnsupportedPlatformError) {
          return c.json(
            { ok: false, error: 'unsupported_platform', message: '当前操作系统暂不支持此功能' },
            422,
          )
        }
        if (error instanceof ApplicationNotFoundError) {
          return c.json(
            { ok: false, error: 'application_not_found', message: '未找到所选应用' },
            422,
          )
        }
        return c.json({ ok: false, error: 'open_failed', message: '无法使用所选应用打开目标' }, 500)
      }
    },
  )

  return app
}
