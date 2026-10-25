import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IOutputStyleService {
  /**
   * Load all available output styles
   */
  listStyles(): Promise<{ styles: OutputStyle[] }>;

  /**
   * Add a new output style
   */
  addStyle(params: { config: OutputStyleConfig }): Promise<void>;

  /**
   * Update an existing output style
   */
  updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void>;

  /**
   * Delete an output style
   */
  deleteStyle(params: { id: string }): Promise<void>;

  /**
   * Get the user's output styles directory path
   */
  getUserStylesDirectory(): Promise<{ path: string }>;

  /**
   * Set the currently active output style
   */
  setActiveStyle(params: { styleId: string }): Promise<void>;

  /**
   * Get the currently active output style
   */
  getActiveStyle(): Promise<{ styleId: string | null }>;
}

export const IOutputStyleService = createServiceDescriptor<IOutputStyleService>(
  ServiceChannels.OutputStyle,
);
