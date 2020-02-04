import { QUERY_LIMIT } from './constants';
import { Credentials } from './credentials';
import RequestManager from './RequestManager';

export type Pair<T> = [T, T];
export class QueryManager extends RequestManager {
  constructor(credentials: Credentials, options: {maxRetries?: number} = {}) {
    super({ ...credentials, server: credentials.server + 'api/v2/sql' }, options);
  }

  public query(q: string, extraParams: Array<Pair<string>> = []) {
    const urlParams = [
      ['api_key', this.apiKey],
      ['q', q],
      ...extraParams
    ];

    if (q.length < QUERY_LIMIT) {
      const stringParams = encodeURI(urlParams.map(
        (param) => `${param[0]}=${param[1]}`
      ).join('&'));

      return new Promise((resolve, reject) => {
        this._scheduleRequest(
          resolve,
          reject,
          `${this.server}?${stringParams}`
        );
      });
    } else {
      const formData = new FormData();

      urlParams.forEach((value) => formData.set(value[0], value[1]));

      return new Promise((resolve, reject) => {
        this._scheduleRequest(
          resolve,
          reject,
          `${this.server}`,
          {
            method: 'POST',
            body: formData
          }
        );
      });
    }
  }
}
