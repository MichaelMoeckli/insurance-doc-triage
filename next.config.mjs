/**
 * Next.js configuration for the single-page demo in `app/`.
 *
 * Two settings, both there for the same reason: the demo is a thin shell around code
 * that was written to run under Node, not under a bundler.
 *
 * `tsconfigPath` - Next rewrites whatever tsconfig it is pointed at, adding the options
 * a bundler needs (`jsx`, `moduleResolution: bundler`, DOM libs). The root
 * `tsconfig.json` deliberately has none of those: it is the Node-side config for the
 * pipeline, the CLIs and the eval harness, and `npm run typecheck` must keep checking
 * them under Node's own module resolution. Pointing Next at a separate file stops the
 * two from fighting over one file.
 *
 * `extensionAlias` - `src/` is Node ESM, so every internal import carries an explicit
 * `./foo.js` specifier: that is what `moduleResolution: NodeNext` requires and what
 * `tsx` resolves. A bundler instead sees a request for a `.js` file that does not exist
 * on disk, so it has to be told to try `.ts` first.
 *
 * That single option is also why the `web:*` scripts pass `--webpack`. Turbopack, the
 * Next 16 default, has no equivalent, and the alternative - dropping the extensions from
 * every import in `src/` - would mean giving up Node-native module resolution across the
 * pipeline, the CLIs and the eval harness so that a demo page could use the newer
 * bundler. The flag is the smaller price.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  typescript: { tsconfigPath: 'tsconfig.web.json' },
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },
};

export default nextConfig;
