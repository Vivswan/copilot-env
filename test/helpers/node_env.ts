// Loaded before every test file (bunfig.toml's [test] preload) and ahead of testing.ts's own
// imports: consola reads NODE_ENV when a logger is created, and `bun test` sets it to "test",
// which drops a logger to warn and leaves the info lines the logger tests assert on empty.
process.env.NODE_ENV = "development";
