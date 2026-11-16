import { CreateImageFields, fileMessages, type ImageDto } from '@app/shared';
import { computed, onScopeDispose, reactive, shallowRef, type ComputedRef, type Ref } from 'vue';

import { errorMessage, isAbortError, isApiError, type ApiError, type ApiErrorCode } from '../../shared/api/http';
import { useSessionStore } from '../../shared/session/session.store';
import { checkImageFile } from './client-file-check';
import { uploadImage } from './upload.api';

/** Form fields in the order they appear, which is the order "focus the first invalid field" follows (F-56). */
export const UPLOAD_FIELDS = ['authorName', 'title', 'description', 'file'] as const;
export type UploadField = (typeof UPLOAD_FIELDS)[number];
export type UploadFieldErrors = Partial<Record<UploadField, string>>;
export type UploadStatus = 'idle' | 'submitting';

/** The text inputs as typed; `CreateImageFields` trims and checks them on submit. */
export interface UploadTextFields {
  authorName: string;
  title: string;
  description: string;
}

/** What one `submit()` ended with; the component decides focus, announcement and events from it. */
export type UploadOutcome =
  | { status: 'uploaded'; image: ImageDto }
  /** Client or server rejected one or more fields; `field` is the first one in form order. */
  | { status: 'invalid'; field: UploadField }
  /** Nothing field-specific went wrong (network, rate limit, expired session); the message is in `formError`. */
  | { status: 'failed'; message: string }
  /** A submit is already running (double submit, B-54 item 2). */
  | { status: 'busy' }
  /** The owner unmounted while the upload was running. */
  | { status: 'cancelled' };

export interface UploadFormState {
  /** Bound with `v-model`; kept on failure, emptied on success (except what was edited while the upload ran). */
  fields: UploadTextFields;
  file: Readonly<Ref<File | null>>;
  /** Object URL of the chosen file once it passed the client check; revoked on change, reset and unmount. */
  previewUrl: Readonly<Ref<string | null>>;
  fieldErrors: Readonly<Ref<UploadFieldErrors>>;
  /** Error that belongs to no field. */
  formError: Readonly<Ref<string | null>>;
  status: Readonly<Ref<UploadStatus>>;
  /**
   * Changes when a successful upload empties the file. The component keys the file picker with it: a file input
   * cannot be emptied reliably by script, but a new element starts empty (ADR 0010, B-54 item 1).
   */
  resetKey: Readonly<Ref<number>>;
  /** The session's effective `UPLOAD_MAX_BYTES` (documented default until the session has answered). */
  maxBytes: ComputedRef<number>;
  // Function-typed properties, not methods: consumers destructure them (`const { submit } = useUploadForm()`).
  selectFile: (file: File | null) => Promise<void>;
  submit: () => Promise<UploadOutcome>;
}

/** Problems that are about the image even when the server sends no `errors[]` entry for `file`. */
const FILE_PROBLEMS: ReadonlySet<ApiErrorCode> = new Set([
  'unsupported-image-type',
  'invalid-image',
  'payload-too-large',
]);

const TEXT_FIELD_NAMES = ['authorName', 'title', 'description'] as const satisfies readonly (keyof UploadTextFields)[];
const TEXT_FIELDS: ReadonlySet<PropertyKey> = new Set<keyof UploadTextFields>(TEXT_FIELD_NAMES);

function isTextField(key: PropertyKey | undefined): key is keyof UploadTextFields {
  return key !== undefined && TEXT_FIELDS.has(key);
}

function emptyFields(): UploadTextFields {
  return { authorName: '', title: '', description: '' };
}

function firstInvalid(errors: UploadFieldErrors): UploadField | undefined {
  return UPLOAD_FIELDS.find((field) => errors[field] !== undefined);
}

/** Field errors from a problem: `errors[]` per field, plus the problem itself when it is about the image. */
function serverFieldErrors(error: ApiError): UploadFieldErrors {
  const errors: UploadFieldErrors = {};
  for (const field of UPLOAD_FIELDS) {
    const message = error.fieldErrors[field];
    if (message !== undefined) errors[field] = message;
  }
  // A 413 may come from nginx without a problem body; the client already mapped it to the image size message.
  if (errors.file === undefined && (FILE_PROBLEMS.has(error.code) || error.status === 413)) errors.file = error.detail;
  return errors;
}

/**
 * State and submission of the upload form (OVERVIEW §8.1, ADR 0010): fields, chosen file and its preview, field
 * errors, status. Validates with the shared contract before sending (`CreateImageFields`, client file check), keeps
 * every value when anything fails and resets everything, the file included, after a `201` (F-24, B-54). The fields
 * stay editable while an upload runs; whatever the person typed or chose meanwhile is the start of the next upload,
 * so the reset empties only the values that were sent.
 *
 * Call it in a component's `setup`: the preview URL is revoked and a running upload is aborted when that component
 * unmounts.
 */
export function useUploadForm(): UploadFormState {
  const session = useSessionStore();

  const fields = reactive<UploadTextFields>(emptyFields());
  const file = shallowRef<File | null>(null);
  const previewUrl = shallowRef<string | null>(null);
  const fieldErrors = shallowRef<UploadFieldErrors>({});
  const formError = shallowRef<string | null>(null);
  const status = shallowRef<UploadStatus>('idle');
  const resetKey = shallowRef(0);
  const maxBytes = computed(() => session.uploadMaxBytes);

  /** Bumped by every selection and reset, so a slow check of an older file never overwrites a newer state. */
  let selection = 0;
  let inFlight: AbortController | null = null;

  function setPreview(url: string | null): void {
    if (previewUrl.value !== null) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = url;
  }

  function setFileError(message: string | undefined): void {
    const { file: _previous, ...others } = fieldErrors.value;
    fieldErrors.value = message === undefined ? others : { ...others, file: message };
  }

  async function selectFile(next: File | null): Promise<void> {
    const current = ++selection;
    setPreview(null);
    file.value = next;
    setFileError(undefined);
    if (next === null) return;

    const result = await checkImageFile(next, maxBytes.value);
    if (current !== selection) return;
    if (result.ok) setPreview(URL.createObjectURL(next));
    else setFileError(result.message);
  }

  /** After a `201`: empties what was sent, keeps what was entered while the upload ran. */
  function reset(sentFields: Readonly<UploadTextFields>, sentFile: File): void {
    for (const key of TEXT_FIELD_NAMES) {
      if (fields[key] === sentFields[key]) fields[key] = '';
    }
    formError.value = null;
    if (file.value !== sentFile) return;
    selection++;
    setPreview(null);
    file.value = null;
    fieldErrors.value = {};
    resetKey.value++;
  }

  function fail(error: unknown): UploadOutcome {
    const errors = isApiError(error) ? serverFieldErrors(error) : {};
    const field = firstInvalid(errors);
    if (field !== undefined) {
      fieldErrors.value = errors;
      return { status: 'invalid', field };
    }
    const message = errorMessage(error);
    formError.value = message;
    return { status: 'failed', message };
  }

  async function submit(): Promise<UploadOutcome> {
    if (status.value === 'submitting') return { status: 'busy' };
    status.value = 'submitting';
    formError.value = null;
    try {
      const errors: UploadFieldErrors = {};
      const typed: UploadTextFields = { ...fields };
      const parsed = CreateImageFields.safeParse(typed);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          if (isTextField(key)) errors[key] ??= issue.message;
        }
      }
      const chosen = file.value;
      if (chosen === null) {
        errors.file = fileMessages.required;
      } else {
        // Again on submit: the session may have answered with a different limit since the file was chosen.
        const check = await checkImageFile(chosen, maxBytes.value);
        if (!check.ok) errors.file = check.message;
      }

      const field = firstInvalid(errors);
      if (field !== undefined) {
        fieldErrors.value = errors;
        return { status: 'invalid', field };
      }
      // Unreachable in practice: every issue of the strict schema names one of the three text fields, and a missing
      // file sets `file`. Narrows the types without a non-null assertion.
      if (!parsed.success || chosen === null) return fail(parsed.error);

      fieldErrors.value = {};
      inFlight = new AbortController();
      const image = await uploadImage(parsed.data, chosen, inFlight.signal);
      reset(typed, chosen);
      return { status: 'uploaded', image };
    } catch (error) {
      if (isAbortError(error)) return { status: 'cancelled' };
      return fail(error);
    } finally {
      inFlight = null;
      status.value = 'idle';
    }
  }

  onScopeDispose(() => {
    selection++;
    inFlight?.abort();
    setPreview(null);
  });

  return { fields, file, previewUrl, fieldErrors, formError, status, resetKey, maxBytes, selectFile, submit };
}
