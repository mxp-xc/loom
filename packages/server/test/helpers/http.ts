import type { Hono } from 'hono'

export async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

export function validationError(error: string) {
  return { ok: false, error, message: 'request validation failed' }
}

export function honoFetch(app: Hono): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const request = new Request(
      new URL(url, 'http://loom.test'),
      input instanceof Request ? input : init,
    )
    return app.fetch(request)
  }
}
