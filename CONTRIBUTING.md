# Contributing to SquadXO

While AI-written contributions are welcome, to keep the maintenance burden reasonable we request prospective contributors put more effort into explaining their PR than the maintainer will need to spend reading it.

Please begin every pull request with a short, human-written note explaining the intent of the change. If English is not your first language, AI translation is acceptable but please provide the note in your native tongue as well.

PRs should be kept to reasonable size and limited in scope to a single issue.

Use Node.js 24.x and the npm version in `package.json`:

```sh
npm ci
npm run build
npm run lint
npm test
```

`build` clears `dist/` and compiles runtime and tests. `lint` checks ESLint, Prettier and TypeScript; `test` rebuilds and uses an isolated Node test runner. For a focused run, pass compiled test paths:

```sh
node scripts/run-tests-isolated.mjs dist/test/plugins/native-coexistence.test.js
```

Runtime integration tests are in `test/server/`; shared plugin boundaries are covered by `test/compatibility/` and `test/plugins/`. Parser and identity changes have tests in `test/logs/` and `test/domain/`. `npm run test:db` covers SQLite, with PostgreSQL and MariaDB enabled by `DB_TEST_POSTGRES_URL` and `DB_TEST_MARIADB_URL` (optional `DB_TEST_POSTGRES_SCHEMA`). Report which dialects ran.

Native plugins follow the [authoring contract](docs/contracts/native-plugin-authoring.md); legacy integrations follow the [compatibility contract](docs/contracts/legacy-plugin-compatibility.md). Persistence changes should account for the [DBLog schema and SQL consumers](docs/contracts/db-log-schema.md).

Edit generated documentation and config through `squad-server/templates/` and plugin metadata. Run `npm run build-all` to regenerate `config.example.json`, `README.md` and `docs/reference/plugins.md`, then run `dist/test/config/generated-artifacts.test.js` through the focused runner. `build-readme` also generates the reference; `build-reference` generates only the reference. Both rebuild first.

When adding or removing runtime TypeScript or legacy plugin/layer JavaScript, review [scripts/package-inputs.json](scripts/package-inputs.json); packaging requires exact inventory equality. See [Deployment](docs/deployment/production.md) for release checks and the production layout: `config.json` beside `index.js`, with startup from the application root.

Pull requests always report **PR validation**. Explicit documentation-only changes run lint, types and generated-artifact parity without database services; runtime, configuration, workflow and unknown paths run the full suite with PostgreSQL and MariaDB. Mixed changes use the full route.

Manual release previews validate, package and smoke the archive without repeating the full database suite. Tag releases and publishing dispatches always run full database validation before publication. Database jobs use the existing `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets for image pulls; absent secrets leave pulls anonymous.
