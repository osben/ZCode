# OAuth Avatar Integration

This implementation carries the login avatar together with user info from the provider to the UI.

## Data Flow

1. The provider's `fetchUserInfo()` reads the third-party `userinfo` endpoint.
2. The provider writes the avatar address into `OAuthUserProfile.avatarUrl`.
3. `OAuthService` keeps `avatarUrl` when converting `OAuthUserProfile` to `UserInfo`.
4. `WorkspaceSidebarFooter` renders the avatar with `AvatarImage`, falling back to initials or a user icon on
   load failure.

## Current Provider Mapping

- BigModel: `userData.avatar` -> `avatarUrl`
- ZAI: `userData.picture` -> `avatarUrl`

## Constraints

- When an old login state stored only the user name, the avatar field may be absent and login restore is
  unaffected.
- A new provider must first confirm the avatar field name in the userinfo response, then add it to
  `OAuthUserProfile`.
