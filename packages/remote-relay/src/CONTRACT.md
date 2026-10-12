# Remote relay

The relay registry is the sole owner of connection authentication and active pairs.
The durable store owns registrations, never task/session data. Authenticated SID
is the isolation key; MID and HTTP routing hints confer no authority.

A newly authenticated terminal replaces the old terminal; a duplicate live device
is rejected. Cleanup is bound to exact connection identity. Opaque frames keep
ordering and contents; the relay never issues business/RPC delivery ACKs.

All queues and anonymous admission are bounded. Store IO runs outside the socket
event loop. Close drains the server/store once, rejects new admission and closes
live transports. WSS termination and public registration do not provide E2EE or
binary/device attestation.
