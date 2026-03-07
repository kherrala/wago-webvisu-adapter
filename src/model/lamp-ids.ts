export const LAMP_IMAGE_OFF = '__visualizationstyle.element-lamp-lamp1-yellow-off';
export const LAMP_IMAGE_ON = '__visualizationstyle.element-lamp-lamp1-yellow-on';

export function normalizeImageId(imageId: string): string {
  return imageId.toLowerCase().replace(/\x00+$/g, '').trim();
}

export function isLampStatusImageId(imageId: string): boolean {
  const normalized = normalizeImageId(imageId);
  return normalized === LAMP_IMAGE_OFF || normalized === LAMP_IMAGE_ON;
}
