/** Bun 读取并打包内置 TOML，运行 dist 时不依赖源码文件路径。 */
declare module "*.toml" {
  const document: unknown;
  export default document;
}
