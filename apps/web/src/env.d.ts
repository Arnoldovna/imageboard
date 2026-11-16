/// <reference types="vite/client" />

import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Page part of the document title ("Page not found" → "Page not found · Imageboard"); none → "Imageboard". */
    title?: string;
    /** The route component sets the document title itself (the image dialog, once its data has loaded). */
    titleFromComponent?: boolean;
  }
}
