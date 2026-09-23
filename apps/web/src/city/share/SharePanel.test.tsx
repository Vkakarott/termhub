// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCity } from '../../lib/types';
import { buildCityModel } from '../../office/model';
import { toMachineEntries } from '../api';

const { recordStory, canRecordVideo, captureStill, canShareFile, shareOrDownload, downloadFile } = vi.hoisted(() => ({
  recordStory: vi.fn(),
  canRecordVideo: vi.fn(() => true),
  captureStill: vi.fn(),
  canShareFile: vi.fn(() => false),
  shareOrDownload: vi.fn(async () => 'shared'),
  downloadFile: vi.fn(),
}));
vi.mock('./record', async (importOriginal) => ({ ...(await importOriginal<typeof import('./record')>()), recordStory, canRecordVideo }));
vi.mock('./images', async (importOriginal) => ({ ...(await importOriginal<typeof import('./images')>()), captureStill }));
vi.mock('./deliver', () => ({ canShareFile, shareOrDownload, downloadFile }));

import { RecordingCancelled, type RecordingResult } from './record';
import { SharePanel, type ShareScene } from './SharePanel';

const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: 'https://77a.it/pedro',
  buildings: [{ id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: '2026-09-23T10:00:00.000Z', activity: 'coding', activity_verb: null, alive: true, progress: null }] }] }],
};
const MODEL = buildCityModel(toMachineEntries(CITY), () => undefined);

let scene: ShareScene & { lockCamera: ReturnType<typeof vi.fn> };
const onClose = vi.fn();

function fakeRecording() {
  let resolve!: (r: RecordingResult) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<RecordingResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const rec = { done, cancel: vi.fn(() => reject(new RecordingCancelled())), resolve, reject };
  recordStory.mockReturnValue(rec);
  return rec;
}

const progress = (ms: number) =>
  act(() => {
    recordStory.mock.calls.at(-1)![0].onProgress(ms);
  });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function renderPanel() {
  return render(<SharePanel scene={scene} city={CITY} model={MODEL} cityUrl="https://termhub.dev/city/@pedro" copyUrl="https://77a.it/pedro" onClose={onClose} />);
}

beforeEach(() => {
  scene = { onFrame: vi.fn(() => () => {}), lockCamera: vi.fn() };
  recordStory.mockReset();
  canRecordVideo.mockReset().mockReturnValue(true);
  captureStill.mockReset();
  canShareFile.mockReset().mockReturnValue(false);
  shareOrDownload.mockReset().mockResolvedValue('shared');
  downloadFile.mockReset();
  onClose.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  setHidden(false);
});

afterEach(() => {
  cleanup();
  setHidden(false);
});

describe('SharePanel', () => {
  it('offers the two images, the video and the link', () => {
    renderPanel();
    expect(screen.getByRole('dialog', { name: 'Compartilhar a cidade' })).toBeTruthy();
    for (const name of ['Story (imagem)', 'Post (imagem)', 'Vídeo para story (10 s, com som)', 'Copiar link']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables the video where the browser cannot record, keeping the images', () => {
    canRecordVideo.mockReturnValue(false);
    renderPanel();
    expect((screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Seu navegador não grava vídeo; as imagens continuam disponíveis.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Story (imagem)' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('records with progress and the camera locked, and cancels back to the options', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    expect(scene.lockCamera).toHaveBeenLastCalledWith(true);
    expect(recordStory.mock.calls[0][0].source).toBe(scene);
    progress(7_000);
    expect(screen.getByText('Gravando… 7 s')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('7');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });
    expect(rec.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Story (imagem)' })).toBeTruthy();
    expect(scene.lockCamera).toHaveBeenLastCalledWith(false);
  });

  // Review Focus 5
  it('stops when the page is hidden, says why, and offers to record again', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    setHidden(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rec.cancel).toHaveBeenCalled();
    expect(screen.getByText(/a gravação parou porque a página saiu da tela/i)).toBeTruthy();
    expect(scene.lockCamera).toHaveBeenLastCalledWith(false);
    setHidden(false);
    fakeRecording();
    fireEvent.click(screen.getByRole('button', { name: 'Gravar de novo' }));
    expect(recordStory).toHaveBeenCalledTimes(2);
  });

  it('hands a finished video to the share sheet where it can, warning about WebM', async () => {
    canShareFile.mockReturnValue(true);
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    await act(async () => {
      rec.resolve({ blob: new Blob(['v'], { type: 'video/webm;codecs=vp9,opus' }), mimeType: 'video/webm;codecs=vp9,opus' });
    });
    expect(screen.getByText('O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    });
    const shared = shareOrDownload.mock.calls[0][0] as File;
    expect(shared.name).toBe('termhub-cidade-pedro-story.webm');
    // the share sheet compares the bare type: codecs in it make Chrome refuse the file
    expect(shared.type).toBe('video/webm');
    expect(screen.getByRole('button', { name: 'Gravar de novo' })).toBeTruthy();
  });

  it('only downloads where there is no share sheet, and says nothing about WebM for an H.264 MP4', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    await act(async () => {
      rec.resolve({ blob: new Blob(['v'], { type: 'video/mp4' }), mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' });
    });
    expect(screen.queryByRole('button', { name: 'Compartilhar' })).toBeNull();
    expect(screen.queryByText(/webm/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(File), 'termhub-cidade-pedro-story.mp4');
  });

  it('warns about an MP4 that does not hold H.264 and AAC (Chromium writes VP9 in it)', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    await act(async () => {
      rec.resolve({ blob: new Blob(['v'], { type: 'video/mp4' }), mimeType: 'video/mp4;codecs=vp9,opus' });
    });
    expect(screen.getByText('O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(File), 'termhub-cidade-pedro-story.mp4');
  });

  it('unlocks the camera and says so when the recording cannot even start', async () => {
    recordStory.mockImplementation(() => {
      throw new Error('no AudioContext');
    });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    });
    expect(scene.lockCamera).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText(/Gravando/)).toBeNull();
    expect(screen.getByText('Não foi possível gerar o arquivo.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gravar de novo' })).toBeTruthy();
  });

  it('makes a story image of the live city, with its short link and counts', async () => {
    captureStill.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story (imagem)' }));
    });
    expect(captureStill).toHaveBeenCalledWith(scene, 'story', { ownerName: 'Pedro', working: 1, waiting: 0, shortLink: '77a.it/pedro' });
    expect(screen.getByRole('img', { name: 'Prévia da imagem' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(File), 'termhub-cidade-pedro-story.png');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Post (imagem)' })).toBeTruthy();
  });

  it('says so when an image cannot be made', async () => {
    captureStill.mockRejectedValue(new Error('no frame from the scene'));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Post (imagem)' }));
    });
    expect(screen.getByText('Não foi possível gerar o arquivo.')).toBeTruthy();
  });

  it('copies the link it was given', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
    expect(screen.getByRole('button', { name: 'Link copiado' })).toBeTruthy();
  });

  it('makes no preview for an image that arrives after the panel was closed', async () => {
    let deliver!: (b: Blob) => void;
    captureStill.mockReturnValue(new Promise<Blob>((res) => (deliver = res)));
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Story (imagem)' }));
    unmount();
    await act(async () => {
      deliver(new Blob(['png'], { type: 'image/png' }));
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('takes the focus on open and keeps it inside while the phases change', async () => {
    captureStill.mockReturnValue(new Promise(() => {}));
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: 'Compartilhar a cidade' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const story = screen.getByRole('button', { name: 'Story (imagem)' });
    story.focus();
    await act(async () => {
      fireEvent.click(story);
    });
    // the pressed button is gone with the menu: the focus must not fall back to the page
    expect(screen.queryByRole('button', { name: 'Story (imagem)' })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Esc without letting the key reach the page underneath', () => {
    const page = vi.fn();
    window.addEventListener('keydown', page);
    try {
      renderPanel();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
      // any other key goes on as usual
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'a' });
      expect(page).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', page);
    }
  });

  it('announces the progress in a live region', async () => {
    fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    progress(3_000);
    expect(screen.getByText('Gravando… 3 s').closest('[aria-live]')).toBeTruthy();
    cleanup();
    captureStill.mockReturnValue(new Promise(() => {}));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Post (imagem)' }));
    });
    expect(screen.getByText('Preparando a imagem…').closest('[aria-live]')).toBeTruthy();
  });

  it('cancels a recording when the panel goes away', () => {
    const rec = fakeRecording();
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    unmount();
    expect(rec.cancel).toHaveBeenCalled();
  });
});
