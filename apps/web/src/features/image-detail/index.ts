// Public API of the image-detail feature (ADR 0017). Other code imports only from here.
//   route component of `/images/:id`: <ImageDetailDialog :id="number" @deleted="(id: number) => …" />
export { default as ImageDetailDialog } from './components/ImageDetailDialog.vue';
