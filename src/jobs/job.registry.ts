import { Injectable, NotFoundException } from '@nestjs/common';
import type { JobHandler } from './job.types.js';

/**
 * Handlers register themselves from their own modules; the registry knows
 * nothing about any specific job (FR-B1 — adding one must not require editing
 * a call site).
 */
@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.name)) {
      throw new Error(`Job "${handler.name}" is already registered`);
    }
    this.handlers.set(handler.name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get(name: string): JobHandler {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new NotFoundException(
        `Unknown job "${name}". Registered: ${this.names().join(', ') || '(none)'}`,
      );
    }
    return handler;
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
