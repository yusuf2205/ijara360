import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { PassportFields, mrzToFields, parseMrz } from './mrz';

// Reads the passport/ID-card photo entirely on our own server (Tesseract, installed in the image) and pulls
// the applicant's details from the MRZ. No image or text ever leaves the machine. Best-effort by design: a
// blurry photo simply yields nothing and the form stays manual, so OCR can never block an upload.
@Injectable()
export class PassportOcrService {
  private readonly log = new Logger('PassportOcr');
  private readonly whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

  /** Run Tesseract on one preprocessed PNG, reading from stdin and writing text to stdout. */
  private tesseract(png: Buffer): Promise<string> {
    return new Promise(resolve => {
      let out = '', finished = false;
      const done = (text: string) => { if (!finished) { finished = true; clearTimeout(timer); resolve(text); } };
      const child = spawn('tesseract', ['stdin', 'stdout', '--psm', '6', '--oem', '1', '-c', `tessedit_char_whitelist=${this.whitelist}`], { stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(''); }, 12000);
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => done('')); // Tesseract missing or unusable → degrade quietly.
      child.on('close', () => done(out));
      child.stdin.on('error', () => {});
      child.stdin.end(png);
    });
  }

  /** A few preprocessings: MRZ reads best from a high-contrast, upscaled grey image; the band is near the bottom. */
  private async candidates(image: Buffer): Promise<Buffer[]> {
    const base = sharp(image, { limitInputPixels: 24_000_000, failOn: 'none' }).rotate(); // honour EXIF orientation
    const meta = await base.metadata();
    const h = meta.height || 0;
    const grey = (p: ReturnType<typeof sharp>) => p.grayscale().normalize().sharpen();
    const out: Buffer[] = [];
    out.push(await grey(base.clone()).resize({ width: 2000, withoutEnlargement: false }).png().toBuffer());
    if (h) {
      const top = Math.floor(h * 0.6);
      const band = base.clone().extract({ left: 0, top, width: meta.width || 1, height: h - top });
      out.push(await grey(band.clone()).resize({ width: 2000, withoutEnlargement: false }).png().toBuffer());
      out.push(await band.grayscale().normalize().resize({ width: 2000, withoutEnlargement: false }).threshold(135).png().toBuffer());
    }
    return out;
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** Serialise scans so several uploads at once never spawn a burst of Tesseract processes. */
  async scan(image: Buffer): Promise<PassportFields | null> {
    const run = this.queue.then(() => this.read(image), () => this.read(image));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Extract passport fields from a document photo, or null when no readable MRZ is found. Never throws. */
  private async read(image: Buffer): Promise<PassportFields | null> {
    try {
      let fallback: PassportFields | null = null;
      for (const png of await this.candidates(image)) {
        const result = parseMrz(await this.tesseract(png));
        if (!result) continue;
        const fields = mrzToFields(result);
        // A passport number that passed its check digit means we read the MRZ cleanly — take it at once.
        if (fields.passportSeries && fields.passportNumber) return fields;
        if (!fallback && Object.keys(fields).length) fallback = fields;
      }
      return fallback;
    } catch (e) {
      this.log.warn(`passport scan failed: ${(e as Error).message}`);
      return null;
    }
  }
}
