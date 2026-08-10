// esbuild loads .css as text (loader: { '.css': 'text' }).
declare module '*.css' {
  const text: string;
  export default text;
}
