# Remote Control Bot Channel Entry

The remote control dialog now simultaneously serves two types of entries:

- Mobile Web: Continues using the current Web remote control session's connection status, QR code, and copy link.
- Bot Channel: Provides WeChat, Feishu, and Telegram entries, targeting long-term or frequently-used communication tools for remote control.

The bot channel card click logic uniformly opens `packages/ui/src/BotsDialog.tsx`:

- If there is already a bot for the corresponding channel, select the first bot for that channel.
- If there is no bot for the corresponding channel, directly create a new bot for that channel and enter the bot's configuration flow.

The entry selection logic is concentrated in `resolveBotProviderEntry()` to avoid the remote control dialog directly understanding the BotsDialog's internal state structure.
