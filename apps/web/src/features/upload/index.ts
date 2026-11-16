// Public API of the upload feature (ADR 0017). Other code imports only from here.
//   <UploadPanel @uploaded="(image: ImageDto) => …" /> exposes open(): void (expands the form, focuses Name)
export { default as UploadPanel } from './components/UploadPanel.vue';
