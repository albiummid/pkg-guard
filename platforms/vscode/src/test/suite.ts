import * as path from 'path';
import Mocha from 'mocha';

/** Entry VS Code calls inside the extension host: runs the tests of the scenario this window was launched for. */
export function run(): Promise<void> {
  const scenario = process.env.PKG_GUARD_SCENARIO;
  if (!scenario) throw new Error('PKG_GUARD_SCENARIO is not set; run the tests with `yarn cli vscode test`.');
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  mocha.addFile(path.join(__dirname, `${scenario}.test.js`));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed in "${scenario}".`)) : resolve()));
  });
}
