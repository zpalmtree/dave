import { fabric } from 'fabric';

export async function loadImage(filename: string): Promise<fabric.Image> {
    return new Promise((resolve, reject) => {
        try {
            fabric.Image.fromURL(`file://${__dirname}/../../images/turtle-tanks/${filename}`, (img) => {
                resolve(img);
            });
        } catch (err) {
            reject(err);
        }
    });
}
