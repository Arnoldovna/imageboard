// Public API of the comments feature (ADR 0017). Other code imports only from here; the image-detail feature is the
// only other feature allowed to (OVERVIEW §6).
//   <CommentsSection :image-id="id" />
export { default as CommentsSection } from './components/CommentsSection.vue';
