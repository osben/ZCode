# Remote relay protocol

Transport-only JSON envelopes and validation shared by relay and clients. The
payload is opaque: no Agent, workspace, task, RPC or Node dependency belongs here.
Each complete uncompressed envelope is limited to 1 MiB; control messages to 4 KiB.
Authentication uses the UTF-8 pass-hash string as HMAC key material. Status is
`waiting` or `matched`; errors are separate messages. Existing proof vectors remain
the compatibility boundary. The contract does not provide end-to-end encryption.
