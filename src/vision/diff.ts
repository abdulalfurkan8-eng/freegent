export interface ScreenDiff { changed:boolean; similarity:number; changedRegions:Array<[number,number,number,number]>; }
export function compareScreenHashes(previous?:string,current?:string): ScreenDiff { if(!previous||!current) return {changed:true,similarity:0,changedRegions:[]}; return {changed:previous!==current,similarity:previous===current?1:0,changedRegions:[]}; }
