# Model Capability Resolution (historical design, retired)

> This document used to describe the old implementation where `models.dev`, the Model Catalog,
> config overrides and per-modelId default policy together inferred model capabilities.
> Provider Refactor retired that implementation. Do not use it as a basis for current code or new
> features.

The only current fact chain is:

```text
ZCode Built-in Model Config Rules
              +
Personal Model Config Rules
              |
              v
Effective Model Config
              |
              v
Provider Registry lookup / validate
              |
              v
ModelFactory
              |
              v
Active Model.properties / optionSpecs / options
```

The current implementation must not:

- fill runtime capabilities from `models.dev`, the Model Catalog or remote model metadata;
- infer context, reasoning, input/output formats or request parameters from a concrete modelId in
  production code;
- let Runtime Config, Turn, Adapter Registry or a UI capability map hold a second copy of model facts;
- let the old `modelCatalog.overrides` into the current Config, Registry or Runtime.

Published legacy CLI Provider/Model JSON is read only at the private parsing boundary of the one-time
importer and is converted immediately into Personal Provider Config and Personal Model Config Rules.

Current specifications:

- [`configuration.md`](../../../../../../docs/working-memory/provider-refactor/design/registry/configuration.md)
- [`registry.md`](../../../../../../docs/working-memory/provider-refactor/design/registry/registry.md)
- [`model-creation.md`](../../../../../../docs/working-memory/provider-refactor/design/registry/model-creation.md)
- [`contract.md`](../../../../../../docs/working-memory/provider-refactor/design/model/contract.md)
