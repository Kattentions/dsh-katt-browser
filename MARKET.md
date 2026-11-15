# Plugin market index

DSH has no central marketplace: a market is just a JSON index (format 1) at an https URL,
which users add under **Plugins → Discover → Index sources**.

This repository publishes one:

- Primary (jsDelivr CDN, no redirects): `https://cdn.jsdelivr.net/gh/Kattentions/dsh-katt-browser@main/index.json`
- Fallback: `https://raw.githubusercontent.com/Kattentions/dsh-katt-browser/main/index.json`

The index lists `dsh-katt-browser` pinned to a commit. After adding it, the plugin appears in
Discover and can be installed from there; direct install also works:

```sh
dsh plugin --profile desktop add github:Kattentions/dsh-katt-browser
```

The format is defined by DSH's `@deepseek-ai/dsh-plugin-market-index`; `index.json` here was
written to match its validation rules (format 1, localized title with `en`, exact SemVer,
integer-second `publishTimestamp`, canonical Git URL plus 40-hex commit).