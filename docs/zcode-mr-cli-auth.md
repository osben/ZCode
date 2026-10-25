# zcode-mr CLI authentication and creation contract

`setup`, `mr` and `create` all use the glab login state of the target GitLab host. glab itself manages
the credential source; the helper does not read environment tokens or credential files, nor send HTTP
requests itself.

```text
setup -> glab auth status --hostname <origin host> -> ready / install or login guidance
mr / create -> same auth check -> validate branch and push -> glab api queries existing MR
                                             |- exists: return IID / URL
                                             '- absent: glab api creates -> return IID / URL
```

- `mr` and `create` behave the same; `create duo <target>` and `mr --duo <target>` stay compatible.
- If auth is unavailable, fail before pushing. Git push still uses Git's own SSH/HTTPS authentication; glab login state does not guarantee push permission.
- Query and creation both go through the glab CLI with the same host passed explicitly. The creation body is passed via JSON stdin, keeping Chinese text, newlines and shell literals, and no token appears in command arguments.
- If the glab query fails, do not continue to create; on a POST error do not retry with other credentials, to avoid duplicate creation when the network is uncertain.
- If push succeeds but MR query/creation fails: exit non-zero with an explicit failure state and a prefilled link. Only `created` / `already_exists` may be reported as success.
- Description conventions, branch protection, DUO title and idempotent existing-MR lookup are unchanged.

Regression coverage: with the CLI missing/not logged in nothing is pushed; logged in without an environment token can create; interpretation of environment tokens is left to glab; host consistency; an existing MR is not recreated; body escaping; query/creation failure exits non-zero; both commands and DUO behave the same.

## Recommended Personal Access Token when not logged in

- When authenticated, reuse it directly; do not log in again or migrate credential storage. When not logged in, print the PAT creation page link for the target host, the suggested scopes `api,write_repository` and the `Token` login method.
- In GitLab avatar -> Edit profile -> Access / Personal access tokens (older versions may call it Access Tokens), create a token: fill in a name and expiry, tick `api` and `write_repository`, and save it on the spot. The token value is shown only at creation and cannot be viewed again from the list.
- The user types it in glab's hidden token prompt; it is never pasted into chat or put in command arguments. Then run setup and verify with a read-only project access check through glab.
- Git/API protocol and credential storage follow the current user's choice. When the current user asks to keep config-file storage, use glab's `--insecure-storage`; this flag is not a default requirement for all new environments. Isolated tests use a private temporary GLAB_CONFIG_DIR with config-file storage selected explicitly and clean up afterwards, to avoid writing the real system keychain.
- The self-hosted GitLab's Web test reported a missing `client_id`. The default token flow needs no OAuth app deployment; handle that prerequisite only when the user explicitly chooses Web/Device.

References: [GitLab PAT creation](https://docs.gitlab.com/user/profile/personal_access_tokens/), [scope reference](https://docs.gitlab.com/security/tokens/access_token_scopes/).
