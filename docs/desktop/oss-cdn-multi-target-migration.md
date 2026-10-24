# OSS/CDN multi-target migration

## Background

The repo version is already `3.1.2`, so the CDN/OSS migration bridge version starts at `3.1.3`. Already installed
old versions read the generic stable feed written into the packaged `app-update.yml` at a fixed address, so the
old CDN's stable feed cannot be taken offline before the bridge version.

## CI variable model

The migration cut-over is done only through CI environment variables:

```bash
CDN_DOMAIN=cdn-zcode.z.ai,cdn.zcode-ai.com,cdn.codegeex.cn
OSS_BUCKET=new-bucket,old-bucket-a,old-bucket-b
OSS_PATH_PREFIX=zcode/electron/releases
OSS_CONFIG_FILE=/etc/ossutil/new,/etc/ossutil/old-a,/etc/ossutil/old-b
```

- `CDN_DOMAIN` supports a comma-separated list; the first item is the primary domain written into the client at
  packaging and used by the release API.
- `OSS_BUCKET` supports a comma-separated list; it must be a single value or match the count of `CDN_DOMAIN`.
- `OSS_PATH_PREFIX` supports reuse of a single value; if multiple values are configured, the count must match
  `CDN_DOMAIN`.
- `OSS_CONFIG_FILE` is optional and supports a single reused value or the count of `CDN_DOMAIN`; once configured,
  each OSS upload group uses the corresponding ossutil config file, so new and old OSS can use different AK/SK
  and regions.
- A count mismatch must fail CI, avoiding writing to the wrong bucket or path.

## Version flow

### 3.1.2

Already released, no longer modified. The old CDN/OSS keeps the stable feed, installers, blockmaps,
`manifest-*.json` and `components/**`.

R3 Source Server versions no longer add legacy manifest/components; this retention rule exists only for
compatibility with existing clients, and regular new-version pipelines must not delete historical objects.

### 3.1.3 bridge version

Configure three targets:

```bash
CDN_DOMAIN=cdn-zcode.z.ai,cdn.zcode-ai.com,cdn.codegeex.cn
OSS_BUCKET=new-bucket,old-bucket-a,old-bucket-b
OSS_CONFIG_FILE=/etc/ossutil/new,/etc/ossutil/old-a,/etc/ossutil/old-b
```

CI uploads the complete `3.1.3` artifacts to the three OSS/CDN groups, and after publish succeeds overwrites the
three stable feeds. Old `3.1.2` clients keep upgrading to `3.1.3` from the old feed; an upgraded `3.1.3` client
embeds the primary domain `cdn-zcode.z.ai` and goes to the new CDN afterwards.

### 3.1.4 cut-over

Configure a single target:

```bash
CDN_DOMAIN=cdn-zcode.z.ai
OSS_BUCKET=new-bucket
OSS_CONFIG_FILE=/etc/ossutil/new
```

From `3.1.4` only the new OSS/CDN is uploaded. The old CDN keeps the `3.1.3` stable feed for a while as a
fallback for `3.1.2` users who have not started the app for a long time.

## Uploaded content per target

Each `{domain, bucket, pathPrefix}` group must have the complete artifacts:

```text
oss://<bucket>/<pathPrefix>/<version>/
  ZCode-...
  latest.yml
  manifest-*.json

oss://<bucket>/<pathPrefix>/components/**

oss://<bucket>/<pathPrefix>/update/<platform>/<arch>/
  updater package
  *.blockmap
```

The update manifest inside the versioned platform directory is uniformly named `latest.yml`, with multi-language
release notes in `releaseNotesByLocale`; the current release chain no longer overwrites the old-style stable
feed. `manifest-*.json` must enter the version directory.

## Verification

- `ci*` branches first verify the three-target upload, warm-up and publish.
- Manually verify the `3.1.2 -> 3.1.3` upgrade from the old feed.
- Manually verify the `3.1.3 -> 3.1.4` upgrade from the new feed.
- Verify the remote runtime can fetch `manifest-*.json` and `components/**` from all three CDNs.
