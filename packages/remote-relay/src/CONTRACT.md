# Remote relay

The relay registry is the sole owner of connection authentication and active pairs.
The durable store owns registrations, never task/session data. Authenticated SID
is the isolation key; MID and HTTP routing hints confer no authority.

Registration lookup is read-only. `touch(sid)` records a verified, admitted
authentication before its ACK. A pending device admission reserves that SID's
device slot; failed or disconnected admissions release it without replacing a
live pair. Store failure remains an internal error, never an invalid-proof error.

A newly authenticated terminal replaces the old terminal; a duplicate live device
is rejected. Cleanup is bound to exact connection identity. Opaque frames keep
ordering and contents; the relay never issues business/RPC delivery ACKs.

All queues and anonymous admission are bounded. Store IO runs outside the socket
event loop. The socket adapter reserves per-socket and aggregate outbound bytes
before sending and releases each reservation once on completion or close; late
callbacks cannot release bytes belonging to another connection.
Close drains the server/store once, rejects new admission and closes
live transports. WSS termination and public registration do not provide E2EE or
binary/device attestation.
