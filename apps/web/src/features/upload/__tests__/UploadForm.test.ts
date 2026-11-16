import { fieldMessages, fileMessages, problemMessages, type ImageDto } from '@app/shared';
import { cleanup, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_REGION, useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import UploadForm from '../components/UploadForm.vue';
import UploadPanel from '../components/UploadPanel.vue';

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];

const uploaded: ImageDto = {
  id: 52,
  url: '/api/media/images/8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f.jpg',
  previewUrl: '/api/media/previews/8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f.webp',
  width: 1200,
  height: 1600,
  mimeType: 'image/jpeg',
  authorName: 'Kofi',
  title: 'Allotment in October',
  description: '',
  createdAt: '2026-11-16T11:05:00.000Z',
  canDelete: true,
};

function photo(name = 'allotment.jpg', size = 420 * 1024): File {
  const content = new Uint8Array(size);
  content.set(JPEG_HEAD);
  return new File([content], name, { type: 'image/jpeg' });
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string, detail: string, errors?: unknown[]): Response {
  return json(
    { type: `tag:example:problem:${code}`, title: code, status, detail, code, ...(errors ? { errors } : {}) },
    status,
    'application/problem+json',
  );
}

type FetchArgs = [input: string, init: RequestInit];

/** Session answers at once; each upload waits for `release()` so the in-flight state can be observed. */
function stubApi(...replies: Response[]) {
  const queue = [...replies];
  const pending: (() => void)[] = [];
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (input) => {
    if (input === '/api/session') return json({ csrfToken: 'csrf-token-7', uploadMaxBytes: 5 * 1024 * 1024 });
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`no reply queued for ${input}`);
    return new Promise<Response>((resolve) => {
      pending.push(() => {
        resolve(reply);
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    /** Lets every upload that has started so far answer. */
    release(): void {
      for (const resolve of pending.splice(0)) resolve();
    },
    uploads: () => fetchMock.mock.calls.filter(([input]) => input === '/api/images'),
  };
}

let pinia: Pinia;

function renderForm() {
  const result = render(UploadForm, { global: { plugins: [pinia] } });
  return { ...result, user: userEvent.setup() };
}

const nameField = () => screen.getByLabelText<HTMLInputElement>('Name (shown publicly)');
const titleField = () => screen.getByLabelText<HTMLInputElement>('Title');
const descriptionField = () => screen.getByLabelText<HTMLTextAreaElement>('Description (optional)');
const fileInput = () => screen.getByLabelText<HTMLInputElement>(/^Image choose/);
const submitButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /upload image|uploading/i });

function describedTexts(control: HTMLElement): string[] {
  const ids = control.getAttribute('aria-describedby')?.split(' ') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent.trim() ?? `missing #${id}`);
}

async function fillValid(user: ReturnType<typeof userEvent.setup>, file = photo()): Promise<void> {
  await user.type(nameField(), 'Kofi');
  await user.type(titleField(), 'Allotment in October');
  await user.upload(fileInput(), file);
  await screen.findByText(`${file.name}, 420 KB`);
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.unstubAllGlobals();
  let previews = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${String(++previews)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

describe('UploadForm: structure (F-17, F-24, F-38, B-12, B-66, B-74)', () => {
  it('is a real form with labelled Name, Title, Description and Image fields in that order', () => {
    const { container } = renderForm();

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    const controls = within(form!).getAllByRole('textbox');
    expect(controls).toEqual([nameField(), titleField(), descriptionField()]);
    expect(form!.contains(fileInput())).toBe(true);
    expect(fileInput().type).toBe('file');
    expect(submitButton().type).toBe('submit');
  });

  it('calls the author field a public name, never an identity (F-38)', () => {
    renderForm();

    expect(nameField().getAttribute('autocomplete')).toBe('nickname');
    expect(screen.queryByText(/user ?name|account|log ?in/i)).toBeNull();
  });

  it('marks Name, Title and Image as required and limits the lengths like the API', () => {
    renderForm();

    expect(nameField().getAttribute('aria-required')).toBe('true');
    expect(titleField().getAttribute('aria-required')).toBe('true');
    expect(descriptionField().hasAttribute('aria-required')).toBe(false);
    expect(fileInput().required).toBe(true);
    expect(nameField().maxLength).toBe(60);
    expect(titleField().maxLength).toBe(120);
    expect(descriptionField().maxLength).toBe(2000);
  });

  it('labels the submit in lowercase, verb first (B-74)', () => {
    renderForm();

    expect(submitButton().textContent.trim()).toBe('upload image');
  });
});

describe('UploadForm: file picker (F-24, B-67)', () => {
  it('keeps the native input in the tab order after the text fields, limited to the four image types', async () => {
    const { user } = renderForm();

    descriptionField().focus();
    await user.tab();

    expect(document.activeElement).toBe(fileInput());
    expect(fileInput().hasAttribute('tabindex')).toBe(false);
    expect(fileInput().accept).toBe('image/jpeg,image/png,image/webp,image/gif');
  });

  it('shows the hint with the limit, then the chosen file name, size and a preview', async () => {
    const { user, container } = renderForm();
    expect(describedTexts(fileInput())).toEqual(['JPEG, PNG, WebP or GIF, up to 5 MB.']);

    await user.upload(fileInput(), photo('IMG_2041.jpg'));

    expect(await screen.findByText('IMG_2041.jpg, 420 KB')).toBeDefined();
    expect(screen.getByLabelText(/^Image choose another image$/)).toBe(fileInput());
    const preview = container.querySelector('img');
    expect(preview?.getAttribute('src')).toBe('blob:preview-1');
    expect(preview?.getAttribute('alt')).toBe('');
    expect(describedTexts(fileInput())).toEqual(['IMG_2041.jpg, 420 KB', 'JPEG, PNG, WebP or GIF, up to 5 MB.']);
  });

  it('rejects a file that is not an image before anything is sent (F-20)', async () => {
    const { fetchMock } = stubApi();
    renderForm();
    const user = userEvent.setup({ applyAccept: false });
    const page = new File(['<!doctype html><title>x</title>'], 'gallery.html', { type: 'text/html' });

    await user.upload(fileInput(), page);

    expect(await screen.findByText(fileMessages.unsupportedType)).toBeDefined();
    expect(fileInput().getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('img')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('UploadForm: validation and focus (F-24, F-56)', () => {
  it('submits with Enter and moves focus to the first invalid field, with linked inline errors', async () => {
    const { fetchMock } = stubApi();
    const { user } = renderForm();

    await user.type(nameField(), 'Kofi{Enter}');

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(titleField());
    });
    expect(titleField().getAttribute('aria-invalid')).toBe('true');
    expect(describedTexts(titleField())).toEqual([fieldMessages.title.required]);
    expect(fileInput().getAttribute('aria-invalid')).toBe('true');
    expect(describedTexts(fileInput())[0]).toBe(fileMessages.required);
    expect(nameField().hasAttribute('aria-invalid')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('focuses the image field when only the file is missing', async () => {
    stubApi();
    const { user } = renderForm();
    await user.type(nameField(), 'Kofi');
    await user.type(titleField(), 'Allotment in October');

    await user.click(submitButton());

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(fileInput());
    });
  });

  it('focuses the field the server rejected', async () => {
    const api = stubApi(
      problem(400, 'validation-failed', problemMessages['validation-failed'], [
        { field: 'title', location: 'body', message: fieldMessages.title.invalid },
      ]),
    );
    const { user } = renderForm();
    await fillValid(user);

    await user.click(submitButton());
    await vi.waitFor(() => {
      expect(api.uploads()).toHaveLength(1);
    });
    api.release();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(titleField());
    });
    expect(describedTexts(titleField())).toEqual([fieldMessages.title.invalid]);
  });
});

describe('UploadForm: submitting (F-17, F-24, B-54)', () => {
  it('reads "Uploading…" and is busy while sending, then emits, announces and resets every field', async () => {
    const api = stubApi(json(uploaded, 201));
    const view = renderForm();
    const { user } = view;
    await fillValid(user);
    await user.type(descriptionField(), 'Last beans of the year.');
    const inputBefore = fileInput();

    await user.click(submitButton());
    await vi.waitFor(() => {
      expect(api.uploads()).toHaveLength(1);
    });
    expect(submitButton().textContent.trim()).toBe('Uploading…');
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    // Busy, not natively disabled: the pressed button keeps keyboard focus (WCAG 2.4.3).
    expect(submitButton().disabled).toBe(false);
    expect(document.activeElement).toBe(submitButton());

    await user.click(submitButton());
    expect(api.uploads()).toHaveLength(1);

    api.release();

    await vi.waitFor(() => {
      expect(view.emitted('uploaded')).toEqual([[uploaded]]);
    });
    await vi.waitFor(() => {
      expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('Image uploaded.');
    });
    expect(submitButton().textContent.trim()).toBe('upload image');
    expect(submitButton().hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(submitButton());
    expect(nameField().value).toBe('');
    expect(titleField().value).toBe('');
    expect(descriptionField().value).toBe('');
    // The native file input is a new, empty element, so the same file is never uploaded twice (B-54 item 1).
    expect(fileInput()).not.toBe(inputBefore);
    expect(fileInput().files?.length ?? 0).toBe(0);
    expect(screen.queryByText(/allotment\.jpg/)).toBeNull();
    expect(screen.getByLabelText(/^Image choose an image$/)).toBe(fileInput());
  });

  it('keeps what was typed or chosen while the upload ran and empties only what was sent', async () => {
    const api = stubApi(json(uploaded, 201));
    const view = renderForm();
    const { user } = view;
    await fillValid(user);

    await user.click(submitButton());
    await vi.waitFor(() => {
      expect(api.uploads()).toHaveLength(1);
    });
    await user.clear(titleField());
    await user.type(titleField(), 'Allotment in November');
    const next = photo('november.jpg');
    await user.upload(fileInput(), next);
    await screen.findByText('november.jpg, 420 KB');
    const inputBefore = fileInput();

    api.release();

    await vi.waitFor(() => {
      expect(view.emitted('uploaded')).toEqual([[uploaded]]);
    });
    expect(nameField().value).toBe('');
    expect(titleField().value).toBe('Allotment in November');
    expect(fileInput()).toBe(inputBefore);
    expect(fileInput().files?.[0]).toBe(next);
    expect(screen.getByText('november.jpg, 420 KB')).toBeDefined();
  });

  it('keeps every value and shows the message as an alert when the upload fails', async () => {
    const detail = 'Too many uploads. Wait a moment and try again.';
    const api = stubApi(problem(429, 'rate-limited', detail));
    const view = renderForm();
    const { user } = view;
    await fillValid(user);

    await user.click(submitButton());
    await vi.waitFor(() => {
      expect(api.uploads()).toHaveLength(1);
    });
    api.release();

    expect((await screen.findByRole('alert')).textContent).toBe(detail);
    expect(nameField().value).toBe('Kofi');
    expect(titleField().value).toBe('Allotment in October');
    expect(screen.getByText('allotment.jpg, 420 KB')).toBeDefined();
    expect(submitButton().hasAttribute('aria-disabled')).toBe(false);
    expect(view.emitted('uploaded')).toBeUndefined();
    expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('');
  });
});

describe('UploadPanel (F-57, ADR 0012)', () => {
  function mountPanel() {
    return mount(UploadPanel, { attachTo: document.body, global: { plugins: [pinia] } });
  }

  it('is a disclosure inside the "Upload an image" heading, collapsed by default', () => {
    const wrapper = mountPanel();

    const toggle = screen.getByRole('button', { name: 'Upload an image' });
    expect(toggle.parentElement?.tagName).toBe('H2');
    expect(screen.getByRole('heading', { level: 2, name: 'Upload an image' })).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(body?.style.display).toBe('none');
    expect(body?.contains(nameField())).toBe(true);
    wrapper.unmount();
  });

  it('expands with the button, focuses Name, and keeps typed values when collapsed again', async () => {
    const wrapper = mountPanel();
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Upload an image' });

    await user.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(nameField());
    });
    await user.type(nameField(), 'Kofi');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(nameField().value).toBe('Kofi');
    wrapper.unmount();
  });

  it('exposes open(), which expands the form and focuses Name (gallery empty state)', async () => {
    const wrapper = mountPanel();

    wrapper.vm.open();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(nameField());
    });
    expect(screen.getByRole('button', { name: 'Upload an image' }).getAttribute('aria-expanded')).toBe('true');
    wrapper.unmount();
  });

  it('passes the uploaded image on to its parent', async () => {
    const api = stubApi(json(uploaded, 201));
    const wrapper = mountPanel();
    const user = userEvent.setup();
    wrapper.vm.open();
    await fillValid(user);

    await user.click(submitButton());
    await vi.waitFor(() => {
      expect(api.uploads()).toHaveLength(1);
    });
    api.release();

    await vi.waitFor(() => {
      expect(wrapper.emitted('uploaded')).toEqual([[uploaded]]);
    });
    wrapper.unmount();
  });
});
