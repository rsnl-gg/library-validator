<p align="center">
  <img src="https://github.com/rsnl-gg/library-validator/blob/master/assets/rsnl_hor_logo_bbg.png" alt="RSNL" width="400">
</p>

<p align="center">
HD2 Arsenal Validator Library
</p>

Validates Helldivers 2 `.patch` mods against game data. It compares unit format versions and detects Lua scripts in a patch file or a mod folder.

## Usage

```bash
npm install @rsnl-gg/library-validator
```

```ts
import { checkUnitCompatibility, hasLuaScript } from "@rsnl-gg/library-validator";


const result = await checkUnitCompatibility(
  "path/to/archive.patch_0",
  "path/to/helldivers2/data",
);

if (!result.compatible) {
  // result.reason is "no-unit" or "version-mismatch"
}

const hasLua = await hasLuaScript("path/to/mod");
if (hasLua.found) {
  // no files written; extractedPaths is []
}

const extracted = await hasLuaScript("path/to/mod", true);
// extracted.extractedPaths is string[] of written .lua files
```

## Library development

```bash
npm install
npm run build
npm run check
```

- `npm run build` compiles `src/` to `dist/`
- `npm run check` runs the integrity tests

Versioning is CalVer `{year}.{month}.{iteration}`. Iteration is `1` on the first publish of the month.

```bash
npm run release
```

The script asks for the version, then commits, tags, pushes, creates a GitHub Release, and only afterwards publishes to npm. GitHub Releases use [GitHub CLI](https://cli.github.com/). Install it once with `winget install --id GitHub.cli` and authenticate with `gh auth login`.

## License

MIT
