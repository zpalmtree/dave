declare module 'imagemin-gifsicle' {
    import { Plugin } from 'imagemin';

    export = imageminGifsicle 

    /**
     * Imagemin plugin for {@link https://www.lcdf.org/gifsicle/|Gifsicle}
     */
    function imageminGifsicle(options?: imageminGifsicle.Options): Plugin;

    namespace imageminGifsicle {
        interface Options {
            /**
             * Reduce the number of distinct colors in each output GIF to num or less.
             * Num must be between 2 and 256.
             */
            colors?: number | undefined;
            /**
             * Interlace gif for progressive rendering.
             * @default false
             */
            interlaced?: boolean | undefined;
            /**
             * Select an optimization level between 1 and 3.
             * @see {@link https://github.com/imagemin/imagemin-gifsicle#optimizationlevel}
             * @default 1
             */
            optimizationLevel?: number | undefined;
        }
    }
}
