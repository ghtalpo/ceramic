package ceramic;

class ArrayPool {

    static var ALLOC_STEP = 10;

/// Factory

    static var dynPool10:ArrayPool = new ArrayPool(10);

    static var dynPool100:ArrayPool = new ArrayPool(100);

    static var dynPool1000:ArrayPool = new ArrayPool(1000);

    static var dynPool10000:ArrayPool = new ArrayPool(10000);

    public static function pool(size:Int):ArrayPool {

        if (size <= 10) {
            return cast dynPool10;
        }
        else if (size <= 100) {
            return cast dynPool100;
        }
        else if (size <= 1000) {
            return cast dynPool1000;
        }
        else if (size <= 10000) {
            return cast dynPool10000;
        }
        else {
            return null;
        }

    } //pool

/// Properties

    var arrays:ReusableArray<ReusableArray<Dynamic>> = null;

    var nextFree:Int = 0;

    var arrayLengths:Int;

/// Lifecycle

    public function new(arrayLengths:Int) {

        this.arrayLengths = arrayLengths;

    } //new

/// Public API

    public function get():ReusableArray<Dynamic> {

        if (arrays == null) arrays = new ReusableArray(ALLOC_STEP);
        else if (nextFree >= arrays.length) arrays.length += ALLOC_STEP;

        var result:ReusableArray<Dynamic> = arrays.get(nextFree);
        if (result == null) {
            result = new ReusableArray(arrayLengths);
            arrays.set(nextFree, result);
        }
        @:privateAccess result._poolIndex = nextFree;

        // Compute next free item
        while (true) {
            nextFree++;
            if (nextFree == arrays.length) break;
            var item = arrays.get(nextFree);
            if (item == null) break;
            if (@:privateAccess item._poolIndex == -1) break;
        }
        
        return cast result;

    } //get

    public function release(array:ReusableArray<Dynamic>):Void {

        var poolIndex = @:privateAccess array._poolIndex;
        @:privateAccess array._poolIndex = -1;
        if (nextFree > poolIndex) nextFree = poolIndex;
        for (i in 0...array.length) {
            array.set(i, null);
        }

    } //release

} //ArrayPool