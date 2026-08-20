export interface DesignJson {
  version?: string;
  objects?: DesignObject[];
  background?: string;
  [key: string]: unknown;
}

export interface BaseDesignObject {
  type?: string;
  name?: string;
  dynamic?: boolean;
  objects?: DesignObject[];
  [key: string]: any;
}

export interface TextDesignObject extends BaseDesignObject {
  type: "textbox" | "text" | "i-text" | string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fill?: string;
  textAlign?: string;
}

export interface ImageDesignObject extends BaseDesignObject {
  type: "image" | string;
  src?: string;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  cropX?: number;
  cropY?: number;
  mediaType?: string;
  videoSrc?: string;
}

export interface ShapeDesignObject extends BaseDesignObject {
  fill?: string;
  opacity?: number;
  backgroundColor?: string;
}

export type DesignObject = TextDesignObject | ImageDesignObject | ShapeDesignObject | BaseDesignObject;
