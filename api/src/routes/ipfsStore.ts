import { composeAPI, generateAddress } from "@iota/core";
import { asTransactionTrytes } from "@iota/transaction-converter";
import crypto from "crypto";
import ipfsClient from "ipfs-http-client";
import { SHA3 } from "sha3";
import { IIPFSStoreRequest } from "../models/api/IIPFSStoreRequest";
import { IIPFSStoreResponse } from "../models/api/IIPFSStoreResponse";
import { IConfiguration } from "../models/configuration/IConfiguration";
import { IPayload } from "../models/tangle/IPayload";
import { BundleCacheService } from "../services/bundleCacheService";
import { StateService } from "../services/stateService";
import { TransactionCacheService } from "../services/transactionCacheService";
import { IotaHelper } from "../utils/iotaHelper";
import { TrytesHelper } from "../utils/trytesHelper";
import { ValidationHelper } from "../utils/validationHelper";

/**
 * Ipfs store command.
 * @param config The configuration.
 * @param request the request.
 * @returns The response.
 */
export async function ipfsStore(config: IConfiguration, request: IIPFSStoreRequest): Promise<IIPFSStoreResponse> {
    try {
        ValidationHelper.string(request.name, "name");
        ValidationHelper.string(request.description, "description");
        ValidationHelper.number(request.size, "size");
        ValidationHelper.string(request.modified, "modified");
        ValidationHelper.string(request.algorithm, "algorithm");
        ValidationHelper.string(request.hash, "hash");
        ValidationHelper.string(request.data, "data");

        await IotaHelper.isNodeAvailable(config.node.provider, true);

        const maxSize = 0.5 * 1048576;

        const buffer = Buffer.from(request.data, "base64");

        if (buffer.length >= maxSize) {
            throw new Error(
                `The file is too large for this demonstration, it should be less than ${
                (maxSize / 1048576).toFixed(1)} Mb.`
            );
        }

        if (buffer.length === 0) {
            throw new Error(`The file must be greater than 0 bytes in length.`);
        }

        let hex;

        if (request.algorithm === "sha256") {
            const hashAlgo = crypto.createHash(request.algorithm);
            hashAlgo.update(buffer);
            hex = hashAlgo.digest("hex");
        } else if (request.algorithm === "sha3") {
            const hashAlgo = new SHA3(256);
            hashAlgo.update(buffer);
            hex = hashAlgo.digest("hex");
        }

        if (hex !== request.hash) {
            throw new Error(
                `The hash for the file is incorrect '${request.hash}' was sent but it has been calculated as '${hex}'`);
        }

        const parts = /(https?):\/\/(.*):(\d*)(.*)/.exec(config.ipfs.provider);

        if (parts.length !== 5) {
            throw new Error(`The IPFS Provider is not formatted correctly, it should be in the format https://ipfs.mydomain.com:443/api/v0/`);
        }

        const ipfsConfig = {
            protocol: parts[1],
            host: parts[2],
            port: parts[3],
            "api-path": parts[4],
            headers: undefined
        };

        if (config.ipfs.token) {
            ipfsConfig.headers = {
                Authorization: `Basic ${config.ipfs.token}`
            };
        }

        const ipfs = ipfsClient(ipfsConfig);

        const addStart = Date.now();
        console.log(`Adding file ${request.name} to IPFS of length ${request.size}`);
        const addResponse = ipfs.add(buffer);

        let ipfsHash;
        for await (const file of addResponse) {
            ipfsHash = file.path;
        }
        console.log(`Adding file ${request.name} complete in ${Date.now() - addStart}ms`);

        const stateService = new StateService(config.dynamoDbConnection);

        let currentState = await stateService.get("default");
        if (!currentState) {
            currentState = {
                seed: TrytesHelper.generateHash(),
                id: "default",
                addressIndex: 0
            };
        } else {
            currentState.addressIndex++;
        }

        await stateService.set(currentState);

        const iota = composeAPI({
            provider: config.node.provider
        });

        const nextAddress = generateAddress(currentState.seed, currentState.addressIndex, 2);

        const tanglePayload: IPayload = {
            name: request.name,
            description: request.description,
            size: request.size,
            modified: request.modified,
            algorithm: request.algorithm,
            hash: request.hash,
            ipfs: ipfsHash
        };

        console.log(`Prepare Transfer`);
        const trytes = await iota.prepareTransfers(
            "9".repeat(81),
            [
                {
                    address: nextAddress,
                    value: 0,
                    message: TrytesHelper.toTrytes(tanglePayload)
                }
            ]);

        const sendStart = Date.now();
        console.log(`Sending Trytes`);
        const bundles = await iota.sendTrytes(trytes, config.node.depth, config.node.mwm);
        console.log(`Sending Trytes complete in ${Date.now() - sendStart}ms`);

        const txHashes = bundles.map(b => b.hash);
        const attachedTrytes = asTransactionTrytes(bundles);
        const bundleCacheService = new BundleCacheService(config.dynamoDbConnection, config.node.provider, true);
        await bundleCacheService.set({ id: bundles[0].bundle, transactionHashes: txHashes });

        const transactionCacheService = new TransactionCacheService(
            config.dynamoDbConnection,
            config.node.provider,
            true);
        for (let i = 0; i < bundles.length; i++) {
            await transactionCacheService.set({ id: bundles[i].hash, trytes: attachedTrytes[i] });
        }

        return {
            success: true,
            message: "OK",
            transactionHash: txHashes[0],
            ipfs: tanglePayload.ipfs
        };
    } catch (err) {
        return {
            success: false,
            message: err.toString()
        };
    }
}
