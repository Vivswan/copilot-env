// Loaded before every test file (bunfig.toml's [test] preload) and ahead of testing.ts's own
// imports, so a test file that never loads the harness still starts under these.
//   NODE_ENV -> "development": consola reads it when a logger is created, and `bun test` sets it
//               to "test", which drops a logger to warn and leaves the info lines the logger
//               tests assert on empty
//   COLUMNS  -> removed: a test process is a pipe with no width, so nothing wraps and a one-line
//               assertion holds for a path of any length; a test that asserts wrapping sets its own
//   NO_COLOR -> "1": the logger picks consola's basic reporter, as under CI=true, so an in-process
//               assertion sees one shape everywhere (the fancy reporter strips backticks)
process.env.NODE_ENV = "development";
delete process.env.COLUMNS;
process.env.NO_COLOR = "1";
