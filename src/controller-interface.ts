// Shared interface for WebVisu controllers (Playwright-based and protocol-based)

export interface LightStatus {
  id: string;
  name: string;
  isOn: boolean;
  isOn2?: boolean;
}

export interface IWebVisuController {
  initialize(): Promise<void>;
  close(): Promise<void>;
  selectLightSwitch(lightId: string): Promise<void>;
  toggleLight(lightId: string, functionNumber?: 1 | 2): Promise<void>;
  getLightStatus(lightId: string): Promise<LightStatus>;
  getAllLights(): Promise<LightStatus[]>;
  navigateToTab(tabName: string): Promise<void>;
  takeScreenshot(): Promise<Buffer>;
  isConnected(): Promise<boolean>;
  getPendingOperationCount(): number;
  resetDropdownState(): void;
  getCanvasInfo?(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  debugStatusIndicator?(): Promise<{ screenshot: Buffer; position: { x: number; y: number }; color: { r: number; g: number; b: number } }>;
}
