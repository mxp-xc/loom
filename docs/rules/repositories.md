# Repository 规则

这些规则定义 repo-scoped API 如何授权 Loom 管理的 repository，以及授权失败时的外部契约。

## R-REPOSITORY-001 Repository 必须是 managed root 的真实直接子目录

Status: active
Applies to: repository listing, repo-scoped API, projection, sync

Rule:
Repo-scoped 操作只接受 safe single-segment repository name。`~/.loom`、`~/.loom/repos` 和选中的 repository 必须是身份稳定的真实目录；repository 必须是 managed repositories root 的 canonical direct child。

Implications:

- Repository listing 与 exact-name resolution 使用同一套授权规则。
- 授权成功后，下游只使用 resolver 返回的 canonical repository path。
- 需要等待 resource lease 的操作在 lease 内开始下游工作前，重新验证 canonical path 与 physical identity。
- Repository name 不接受空值、`.`、`..`、separator、absolute path、drive path、control character 或 hidden entry。

Safety:

- Managed root 或 repository entry 是 link、junction、非目录、canonical escape，或验证期间 identity 漂移时，操作 fail closed。
- Repository 在授权后、lease 获取前被删除或替换时，操作按 `repo_unavailable` fail closed，不能触达替换后的 entry。
- 两个 entry 指向同一 canonical path 或 physical identity 时，整个 repository view 视为不可用，不能任意选择其中一个。

Examples:

- `demo` 对应 `~/.loom/repos/demo` 的真实直接子目录时可以被授权。
- `../demo`、`team/demo`、指向外部目录的 `demo` link 都不能被授权。

Tests:

- packages/server/test/api/repo.test.ts
- packages/server/test/api/repository-access-routes.test.ts

## R-REPOSITORY-002 Repository authorization error 保持稳定

Status: active
Applies to: repo-scoped HTTP API

Rule:
合法但未知或不符合 entry policy 的 repository 返回 HTTP 400 `invalid_repo`；managed root IO、identity ambiguity、race 或其他 operational failure 返回 HTTP 500 `repo_unavailable`。

Implications:

- 所有 repo-scoped endpoints 保留相同的 status、code 和安全 message。
- Repository authorization 失败后，不调用 application、Git、projection 或 filesystem mutation。
- Response 不包含原始 path、filesystem message、stack 或 cause。

Safety:

- Error mapping 不能把 `repo_unavailable` 降成 caller error、operation-specific error 或 HTTP 200 failure body。
- 错误边界记录完整 error object 和 stack context，不能只记录 `err.message`。

Examples:

- 请求不存在的 `demo` 返回 400 `invalid_repo`。
- `~/.loom/repos` 在授权期间发生 EIO 返回 500 `repo_unavailable`，且下游零调用。

Tests:

- packages/server/test/api/repository-access-routes.test.ts
- packages/server/test/api/vars-routes.test.ts
