const nql = require('@tryghost/nql');
const {BadRequestError} = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const errors = require('@tryghost/errors');
const ObjectId = require('bson-objectid').default;
const omit = require('lodash/omit');

const messages = {
    invalidVisibilityFilter: 'Invalid visibility filter.',
    invalidVisibility: 'Invalid visibility value.',
    invalidTiers: 'Invalid tiers value.',
    invalidTags: 'Invalid tags value.',
    invalidEmailSegment: 'The email segment parameter doesn\'t contain a valid filter',
    unsupportedBulkAction: 'Unsupported bulk action',
    postNotFound: 'Post not found.',
    collectionNotFound: 'Collection not found.'
};

class PostsService {
    constructor({urlUtils, models, isSet, stats, emailService, postsExporter, collectionsService}) {
        this.urlUtils = urlUtils;
        this.models = models;
        this.isSet = isSet;
        this.stats = stats;
        this.emailService = emailService;
        this.postsExporter = postsExporter;
        /** @type {import('@tryghost/collections').CollectionsService} */
        this.collectionsService = collectionsService;
    }

    /**
     *
     * @param {Object} options - frame options
     * @returns {Promise<Object>}
     */
    async browsePosts(options) {
        let posts;
        if (this.isSet('collections') && options.collection) {
            let collection = await this.collectionsService.getById(options.collection);

            if (!collection) {
                collection = await this.collectionsService.getBySlug(options.collection);
            }

            if (!collection) {
                throw new errors.NotFoundError({
                    message: tpl(messages.collectionNotFound)
                });
            }

            const postIds = collection.posts;
            options.filter = `id:[${postIds.join(',')}]+type:post`;
            posts = await this.models.Post.findPage(options);
        } else {
            posts = await this.models.Post.findPage(options);
        }

        return posts;
    }

    async readPost(frame) {
        const model = await this.models.Post.findOne(frame.data, frame.options);

        if (!model) {
            throw new errors.NotFoundError({
                message: tpl(messages.postNotFound)
            });
        }

        const dto = model.toJSON(frame.options);

        if (this.isSet('collections') && frame?.original?.query?.include?.includes('collections')) {
            dto.collections = await this.collectionsService.getCollectionsForPost(model.id);
        }

        return dto;
    }

    /**
     * @typedef {'published_updated' | 'scheduled_updated' | 'draft_updated' | 'unpublished'} EventString
     */

    /**
     *
     * @param {any} frame
     * @param {object} [options]
     * @param {(event: EventString, dto: any) => Promise<void> | void} [options.eventHandler] - Called before the editPost method resolves with an event string
     * @returns
     */
    async editPost(frame, options) {
        // Make sure the newsletter is matching an active newsletter
        // Note that this option is simply ignored if the post isn't published or scheduled
        if (frame.options.newsletter && frame.options.email_segment) {
            if (frame.options.email_segment !== 'all') {
                // check filter is valid
                try {
                    await this.models.Member.findPage({filter: frame.options.email_segment, limit: 1});
                } catch (err) {
                    return Promise.reject(new BadRequestError({
                        message: tpl(messages.invalidEmailSegment),
                        context: err.message
                    }));
                }
            }
        }

        if (this.isSet('collections') && frame.data.posts[0].collections) {
            const existingCollections = await this.collectionsService.getCollectionsForPost(frame.options.id);
            for (const collection of frame.data.posts[0].collections) {
                let collectionId = null;
                if (typeof collection === 'string') {
                    collectionId = collection;
                }
                if (typeof collection?.id === 'string') {
                    collectionId = collection.id;
                }
                if (!collectionId) {
                    continue;
                }
                const existingCollection = existingCollections.find(c => c.id === collectionId);
                if (existingCollection) {
                    continue;
                }
                const found = await this.collectionsService.getById(collectionId);
                if (!found) {
                    continue;
                }
                if (found.type !== 'manual') {
                    continue;
                }
                await this.collectionsService.addPostToCollection(collectionId, {
                    id: frame.options.id,
                    featured: frame.data.posts[0].featured,
                    published_at: frame.data.posts[0].published_at
                });
            }
            for (const existingCollection of existingCollections) {
                if (frame.data.posts[0].collections.find((item) => {
                    if (typeof item === 'string') {
                        return item === existingCollection.id;
                    }
                    return item.id === existingCollection.id;
                })) {
                    continue;
                }
                await this.collectionsService.removePostFromCollection(existingCollection.id, frame.options.id);
            }
        }

        const model = await this.models.Post.edit(frame.data.posts[0], frame.options);

        /**Handle newsletter email */
        if (model.get('newsletter_id')) {
            const sendEmail = model.wasChanged() && this.shouldSendEmail(model.get('status'), model.previous('status'));

            if (sendEmail) {
                let postEmail = model.relations.email;
                let email;

                if (!postEmail) {
                    email = await this.emailService.createEmail(model);
                } else if (postEmail && postEmail.get('status') === 'failed') {
                    email = await this.emailService.retryEmail(postEmail);
                }
                if (email) {
                    model.set('email', email);
                }
            }
        }

        const dto = model.toJSON(frame.options);

        if (this.isSet('collections')) {
            if (frame?.original?.query?.include?.includes('collections') || frame.data.posts[0].collections) {
                dto.collections = await this.collectionsService.getCollectionsForPost(model.id);
            }
        }

        if (typeof options?.eventHandler === 'function') {
            await options.eventHandler(this.getChanges(model), dto);
        }

        return dto;
    }
    /**
     * @param {any} model
     * @returns {EventString}
     */
    getChanges(model) {
        if (model.get('status') === 'published' && model.wasChanged()) {
            return 'published_updated';
        }

        if (model.get('status') === 'draft' && model.previous('status') === 'published') {
            return 'unpublished';
        }

        if (model.get('status') === 'draft' && model.previous('status') !== 'published') {
            return 'draft_updated';
        }

        if (model.get('status') === 'scheduled' && model.wasChanged()) {
            return 'scheduled_updated';
        }
    }

    #mergeFilters(...filters) {
        return filters.filter(filter => filter).map(f => `(${f})`).join('+');
    }

    async bulkEdit(data, options) {
        if (data.action === 'unpublish') {
            return await this.#updatePosts({status: 'draft'}, {filter: this.#mergeFilters('status:published', options.filter), context: options.context, actionName: 'unpublished'});
        }
        if (data.action === 'feature') {
            return await this.#updatePosts({featured: true}, {filter: options.filter, context: options.context, actionName: 'featured'});
        }
        if (data.action === 'unfeature') {
            return await this.#updatePosts({featured: false}, {filter: options.filter, context: options.context, actionName: 'unfeatured'});
        }
        if (data.action === 'access') {
            if (!['public', 'members', 'paid', 'tiers'].includes(data.meta.visibility)) {
                throw new errors.IncorrectUsageError({
                    message: tpl(messages.invalidVisibility)
                });
            }
            let tiers = undefined;
            if (data.meta.visibility === 'tiers') {
                if (!Array.isArray(data.meta.tiers)) {
                    throw new errors.IncorrectUsageError({
                        message: tpl(messages.invalidTiers)
                    });
                }
                tiers = data.meta.tiers;
            }
            return await this.#updatePosts({visibility: data.meta.visibility, tiers}, {filter: options.filter, context: options.context});
        }
        if (data.action === 'addTag') {
            if (!Array.isArray(data.meta.tags)) {
                throw new errors.IncorrectUsageError({
                    message: tpl(messages.invalidTags)
                });
            }
            for (const tag of data.meta.tags) {
                if (typeof tag !== 'object') {
                    throw new errors.IncorrectUsageError({
                        message: tpl(messages.invalidTags)
                    });
                }
                if (!tag.id && !tag.name) {
                    throw new errors.IncorrectUsageError({
                        message: tpl(messages.invalidTags)
                    });
                }
            }
            return await this.#bulkAddTags({tags: data.meta.tags}, {filter: options.filter, context: options.context});
        }
        throw new errors.IncorrectUsageError({
            message: tpl(messages.unsupportedBulkAction)
        });
    }

    /**
     * @param {object} data
     * @param {string[]} data.tags - Array of tag ids to add to the post
     * @param {object} options
     * @param {string} options.filter - An NQL Filter
     * @param {object} options.context
     * @param {object} [options.transacting]
     */
    async #bulkAddTags(data, options) {
        if (!options.transacting) {
            return await this.models.Post.transaction(async (transacting) => {
                return await this.#bulkAddTags(data, {
                    ...options,
                    transacting
                });
            });
        }

        // Create tags that don't exist
        for (const tag of data.tags) {
            if (!tag.id) {
                const createdTag = await this.models.Tag.add(tag, {transacting: options.transacting, context: options.context});
                tag.id = createdTag.id;
            }
        }

        const postRows = await this.models.Post.getFilteredCollectionQuery({
            filter: options.filter,
            status: 'all',
            transacting: options.transacting
        }).select('posts.id');

        const postTags = data.tags.reduce((pt, tag) => {
            return pt.concat(postRows.map((post) => {
                return {
                    id: (new ObjectId()).toHexString(),
                    post_id: post.id,
                    tag_id: tag.id,
                    sort_order: 0
                };
            }));
        }, []);

        await options.transacting('posts_tags').insert(postTags);
        await this.models.Post.addActions('edited', postRows.map(p => p.id), options);

        return {
            successful: postRows.length,
            unsuccessful: 0
        };
    }

    async bulkDestroy(options) {
        if (!options.transacting) {
            return await this.models.Post.transaction(async (transacting) => {
                return await this.bulkDestroy({
                    ...options,
                    transacting
                });
            });
        }

        const postRows = await this.models.Post.getFilteredCollectionQuery({
            filter: options.filter,
            status: 'all',
            transacting: options.transacting
        }).leftJoin('emails', 'posts.id', 'emails.post_id').select('posts.id', 'emails.id as email_id');
        const deleteIds = postRows.map(row => row.id);

        // We also need to collect the email ids because the email relation doesn't have cascase, and we need to delete the related relations of the post
        const deleteEmailIds = postRows.map(row => row.email_id).filter(id => !!id);

        const postTablesToDelete = [
            'posts_authors',
            'posts_tags',
            'posts_meta',
            'mobiledoc_revisions',
            'post_revisions',
            'posts_products'
        ];
        const emailTablesToDelete = [
            'email_recipient_failures',
            'email_recipients',
            'email_batches',
            'email_spam_complaint_events'
        ];

        // Don't clear, but set relation to null
        const emailTablesToSetNull = [
            'suppressions'
        ];

        for (const table of postTablesToDelete) {
            await this.models.Post.bulkDestroy(deleteIds, table, {
                column: 'post_id',
                transacting: options.transacting,
                throwErrors: true
            });
        }

        for (const table of emailTablesToDelete) {
            await this.models.Post.bulkDestroy(deleteEmailIds, table, {
                column: 'email_id',
                transacting: options.transacting,
                throwErrors: true
            });
        }

        for (const table of emailTablesToSetNull) {
            await this.models.Post.bulkEdit(deleteEmailIds, table, {
                data: {email_id: null},
                column: 'email_id',
                transacting: options.transacting,
                throwErrors: true
            });
        }

        // Posts and emails
        await this.models.Post.bulkDestroy(deleteEmailIds, 'emails', {transacting: options.transacting, throwErrors: true});
        return await this.models.Post.bulkDestroy(deleteIds, 'posts', {...options, throwErrors: true});
    }

    async export(frame) {
        return await this.postsExporter.export(frame.options);
    }

    async #updatePosts(data, options) {
        if (!options.transacting) {
            return await this.models.Post.transaction(async (transacting) => {
                return await this.#updatePosts(data, {
                    ...options,
                    transacting
                });
            });
        }

        const postRows = await this.models.Post.getFilteredCollectionQuery({
            filter: options.filter,
            status: 'all',
            transacting: options.transacting
        }).select('posts.id');

        const editIds = postRows.map(row => row.id);

        let tiers = undefined;
        if (data.tiers) {
            tiers = data.tiers;
            delete data.tiers;
        }

        const result = await this.models.Post.bulkEdit(editIds, 'posts', {
            ...options,
            data,
            throwErrors: true
        });

        // Update tiers
        if (tiers) {
            // First delete all
            await this.models.Post.bulkDestroy(editIds, 'posts_products', {
                column: 'post_id',
                transacting: options.transacting,
                throwErrors: true
            });

            // Then add again
            const toInsert = [];
            for (const postId of editIds) {
                for (const [index, tier] of tiers.entries()) {
                    if (typeof tier.id === 'string') {
                        toInsert.push({
                            id: ObjectId().toHexString(),
                            post_id: postId,
                            product_id: tier.id,
                            sort_order: index
                        });
                    }
                }
            }
            await this.models.Post.bulkAdd(toInsert, 'posts_products', {
                transacting: options.transacting,
                throwErrors: true
            });
        }

        return result;
    }

    async getProductsFromVisibilityFilter(visibilityFilter) {
        try {
            const allProducts = await this.models.Product.findAll();
            const visibilityFilterJson = nql(visibilityFilter).toJSON();
            const productsData = (visibilityFilterJson.product ? [visibilityFilterJson] : visibilityFilterJson.$or) || [];
            const tiers = productsData
                .map((data) => {
                    return allProducts.find((p) => {
                        return p.get('slug') === data.product;
                    });
                }).filter(p => !!p).map((d) => {
                    return d.toJSON();
                });
            return tiers;
        } catch (err) {
            return Promise.reject(new BadRequestError({
                message: tpl(messages.invalidVisibilityFilter),
                context: err.message
            }));
        }
    }

    /**
     * Calculates if the email should be tried to be sent out
     * @private
     * @param {String} currentStatus current status from the post model
     * @param {String} previousStatus previous status from the post model
     * @returns {Boolean}
     */
    shouldSendEmail(currentStatus, previousStatus) {
        return (['published', 'sent'].includes(currentStatus))
            && (!['published', 'sent'].includes(previousStatus));
    }

    handleCacheInvalidation(model) {
        let cacheInvalidate;

        if (
            model.get('status') === 'published' && model.wasChanged() ||
            model.get('status') === 'draft' && model.previous('status') === 'published'
        ) {
            cacheInvalidate = true;
        } else if (
            model.get('status') === 'draft' && model.previous('status') !== 'published' ||
            model.get('status') === 'scheduled' && model.wasChanged()
        ) {
            cacheInvalidate = {
                value: this.urlUtils.urlFor({
                    relativeUrl: this.urlUtils.urlJoin('/p', model.get('uuid'), '/')
                })
            };
        } else {
            cacheInvalidate = false;
        }

        return cacheInvalidate;
    }

    async copyPost(frame) {
        const existingPost = await this.models.Post.findOne({
            id: frame.options.id,
            status: 'all'
        }, frame.options);

        const newPostData = omit(
            existingPost.attributes,
            [
                'id',
                'uuid',
                'slug',
                'comment_id',
                'created_at',
                'created_by',
                'updated_at',
                'updated_by',
                'published_at',
                'published_by',
                'canonical_url',
                'count__clicks'
            ]
        );

        newPostData.title = `${existingPost.attributes.title} (Copy)`;
        newPostData.status = 'draft';
        newPostData.authors = existingPost.related('authors')
            .map(author => ({id: author.get('id')}));
        newPostData.tags = existingPost.related('tags')
            .map(tag => ({id: tag.get('id')}));

        const existingPostMeta = existingPost.related('posts_meta');

        if (existingPostMeta.isNew() === false) {
            newPostData.posts_meta = omit(
                existingPostMeta.attributes,
                [
                    'id',
                    'post_id'
                ]
            );
        }

        const existingPostTiers = existingPost.related('tiers');

        if (existingPostTiers.length > 0) {
            newPostData.tiers = existingPostTiers.map(tier => ({id: tier.get('id')}));
        }

        return this.models.Post.add(newPostData, frame.options);
    }

    /**
     * Generates a location url for a copied post based on the original url generated by the API framework
     *
     * @param {string} url
     * @returns {string}
     */
    generateCopiedPostLocationFromUrl(url) {
        const urlParts = url.split('/');
        const pageId = urlParts[urlParts.length - 2];

        return urlParts
            .slice(0, -4)
            .concat(pageId)
            .concat('')
            .join('/');
    }
}

module.exports = PostsService;
