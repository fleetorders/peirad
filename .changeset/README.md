# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). Each change that
should affect the published version adds a markdown file here describing it.

- Add one: `npx changeset`.
- Version + write the changelog: `npm run version:packages`.
- Publish: `npm publish` (the `prepublishOnly` script builds and screens the package first).
