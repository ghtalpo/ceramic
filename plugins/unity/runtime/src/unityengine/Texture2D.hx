package unityengine;

import cs.NativeArray;
import cs.types.UInt8;

@:native('UnityEngine.Texture2D')
extern class Texture2D extends Texture {

    var width:Int;

    var height:Int;

    var filterMode:FilterMode;

    function GetInstanceID():Int;

    function SetPixelData(data:NativeArray<UInt8>, mipLevel:Int, sourceDataStartIndex:Int):Void;

    function Apply(updateMipmaps:Bool, makeNoLongerReadable:Bool):Void;

}
