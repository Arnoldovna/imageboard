// Public API of the gallery feature (ADR 0017). Other code imports only from here.
//   <GallerySection @request-upload /> exposes focusTile(id: number): void
//   useGalleryStore(): items, nextCursor, status, moreStatus, error, loadFirst, loadMore, retry, prepend, remove
export { default as GallerySection } from './components/GallerySection.vue';
export { useGalleryStore, type GalleryMoreStatus, type GalleryStatus } from './gallery.store';
