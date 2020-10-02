declare module '@vitalets/google-translate-api' {
    export = googleTranslateApi

    function googleTranslateApi(
      query: string,
      opts?: googleTranslateApi.IOptions,
    ): Promise<googleTranslateApi.ITranslateResponse>

    namespace googleTranslateApi {
      export interface Languages {
        [index: string]: string;
      }

      var languages: Languages;

      export interface IOptions {
        from?: string
        to?: string
        client?: 't' | 'gtx'
      }

      export interface ITranslateLanguage {
        didYouMean: boolean
        iso: string
      }

      export interface ITranslateText {
        autoCorrected: boolean
        value: string
        didYouMean: boolean
      }

      export interface ITranslateResponse {
        text: string
        pronunciation: string
        from: {
          language: ITranslateLanguage
          text: ITranslateText
        }
        raw: string
      }
    }
}
