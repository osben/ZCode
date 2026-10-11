declare module "*.css";
declare module "*.mp3";
declare module "*.png";
declare module "*.svg";
declare module "*.webp";

// Vite `?url` asset imports (such as the pdf.js worker) return a string containing the bundled asset URL.
declare module "*?url" {
  const src: string;
  export default src;
}
