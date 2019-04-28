package ceramic;

/** Tilemap data.
    Strongly inspired from Tiled TMX format.
    (https://doc.mapeditor.org/en/stable/reference/tmx-map-format/) */
class TilemapData extends Entity {

/// Main properties

    /** Map orientation, can be `ORTHOGONAL`, `ISOMETRIC`, `STAGGERED` or `HEXAGONAL`. */
    public var orientation:TilemapOrientation = ORTHOGONAL;

    /** The width of a tile */
    public var tileWidth:Int = -1;

    /** The height of a tile */
    public var tileHeight:Int = -1;

    /** The map width in tiles */
    public var width:Int = -1;

    /** The map height in tiles */
    public var height:Int = -1;

    /** The order in which tiles on tile layers are rendered.
        In all cases, the map is drawn row-by-row. */
    public var renderOrder:TilemapRenderOrder = RIGHT_DOWN;

    /** Only for hexagonal maps. Determines the width or height
        (depending on the staggered axis) of the tile's edge */
    public var hexSideLength:Int = -1;

    /** For staggered and hexagonal maps, determines which axis (x or y) is staggered. */
    public var staggerAxis:TilemapStaggerAxis = AXIS_X;

    /** For staggered and hexagonal maps, determines whether the
        `EVEN` or `ODD` indexes along the staggered axis are shifted. */
    public var staggerIndex:TilemapStaggerIndex = ODD;

    /** The background color of the map. */
    public var backgroundColor:AlphaColor = new AlphaColor(Color.WHITE, 0);

/// Sub objects
    
    public var tilesets:Array<Tileset> = [];
    
    public var layers:Array<TilemapLayer> = [];

/// Lifecycle

    public function new() {

    } //new

    override function destroy() {

        //
        
    } //destroy

/// Print

    override function toString():String {
        
        return '' + {
            orientation: orientation,
            tileWidth: tileWidth,
            tileHeight: tileHeight,
            width: width,
            height: height,
            renderOrder: renderOrder,
            hexSideLength: hexSideLength,
            staggerAxis: staggerAxis,
            staggerIndex: staggerIndex,
            backgroundColor: backgroundColor.toString(),
            tilesets: tilesets,
            layers: layers,
        }

    } //toString

} //TilemapData