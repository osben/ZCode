# Highspeed Client-generated Share Card

## Constraints

- After an acceleration card expires, the client publishes a lower-left share card directly from persisted token/TPS statistics; it no longer calls the server `share` API.
- The in-session entry point and lower-left entry point open the same share dialog. Keep the Copy image action in that dialog.
- Copy image generates an SVG of the statistics area only; it excludes the dialog footer copy and buttons.
- Remove share URLs, share IDs, and related mocks from the Highspeed sharing flow.

## 20/80 Time Estimation

- Total time for an ordinary model consists of 20% tool time and 80% model-inference time.
- Highspeed shortens only model inference; tool time stays the same. Calculate the model-inference speedup using the card-level `highspeedTps / regularTps` ratio.
- For each message, use the actual Highspeed execution time `H` to derive ordinary-model time: `N = H / (0.2 + 0.8 / modelSpeedup)`.
- Time saved is `max(N - H, 0)`. Calculate each of multiple serial messages on the same card separately, then sum them to avoid errors from deriving total time directly from card-level TPS.

## Persisting Actual CLI Durations

- At turn termination, the CLI aggregates `modelDurationMs` and `toolDurationMs` from model-request and tool-lifecycle events. It writes both, along with unclassified `otherDurationMs`, to the `highspeed` metadata on the user transcript. These fields are optional to retain compatibility with old messages.
- Share statistics prefer this persisted actual breakdown: keep tool time unchanged and derive ordinary model time using the `highspeedTps / regularTps` ratio. Ordinary total time = tool time + other time + ordinary model time.
- If older messages lack actual breakdown fields, continue using the 20/80 estimate above so historical cards remain valid after the schema upgrade.
- For parallel tool execution, calculate the union of time intervals to avoid double-counting concurrent tools. Accumulate model-retry requests using each request's actual duration.
