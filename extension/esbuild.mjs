import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/**
 * The extension host is Node.js + CommonJS, so the bundle target is `cjs`.
 * `vscode` is provided by the host at runtime and `pg-native` is an optional
 * native addon of `pg` that must stay unresolved. `cpu-features` is the same
 * kind of optional native addon for `ssh2`; ssh2 already guards the require.
 */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode', 'pg-native', 'cpu-features'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
  console.log('[esbuild] watching extension/src')
} else {
  await esbuild.build(options)
}
