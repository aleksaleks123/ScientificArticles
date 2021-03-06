var reviewsRepository = require('../repository/reviewsRepository');
var articleRepository = require('../repository/articlesRepository');
var userRepository = require('../repository/userRepository');
const authorizationService = require('./authorizationService')
const mailService = require('./mailService')
var xmldom = require('xmldom');
var XMLSerializer = xmldom.XMLSerializer;
var DOMParser = xmldom.DOMParser;
var xpath = require('xpath');

const xsltService = require('./xsltService');
const fs = require('fs');

var ns = "https://github.com/XML-tim17/ScientificArticles";

module.exports.postReview = async (reviewXML, reviewer) => {
    // get article id
    let reviewDOM = new DOMParser().parseFromString(reviewXML, 'text/xml');
    let select = xpath.useNamespaces({'ns': ns})
    let articleNode = select('//ns:article-id', reviewDOM)[0]
    let articleId = articleNode.firstChild.data; // example: 1
    let version = await articleRepository.getLastVersion(articleId);
    articleId = `article${articleId}/v${version}`;
    articleNode.firstChild.data = articleId;
    reviewXML = new XMLSerializer().serializeToString(reviewDOM);

    // check if reviewer email is correct in review
    let reviewerEmail = select('//ns:reviewer/ns:email', reviewDOM)[0].textContent;
    if(reviewerEmail !== reviewer.email) {
        let error = new Error('Reviewer email in review does not match users email.')
        error.status = 400;
        throw error;
    }

    // check article state
    let status = await articleRepository.getStatusOfByURI(articleId);
    console.log('status', status);
    if (status !== 'inReviewProcess') {
        let error = new Error('Invalid review, target article is not in review process.')
        error.status = 400;
        throw error;
    }
    

    // check if user can review this article
    if(!reviewer.toReview.includes(articleId.split('/')[0])) {
        let error = new Error('Article is not assigned to this reviewer');
        error.status = 400;
        throw error;
    }

    // check if user has already reviewed this article
    const reviewed = await reviewsRepository.existsByEmailAndArticleURI(reviewer.email, articleId);
    if (reviewed === 'true') {
        let error = new Error('Article has already been reviewed by this user.')
        error.status = 400;
        throw error;
    }

    // get aricle by id
    let articleDOM = await articleRepository.getById(articleId);

    // check references
    let ref_ids = select('//@reference-id', reviewDOM).map(node => node.value);
    let ids = select('//@ns:id', articleDOM).map(node => node.value);

    for (let ref_id of ref_ids) {
        if(!ids.includes(ref_id)) {
            let error =  new Error('Invalid review, comment references non existing id');
            error.status = 400;
            throw error;
        }
    }

    // save review in exist
    let reviewCount = await reviewsRepository.incrementReviewCount(1);
    await reviewsRepository.addNewReview(reviewXML, reviewCount);

    // get count of reviews for article
    let articleReviewCount = await reviewsRepository.getArticleReviewCount(articleId);

    // get count of needed reviews for article
    let toReviewCount = await reviewsRepository.getToReviewByArticleId(articleId.split('/')[0])

    if (articleReviewCount >= toReviewCount) {
        articleRepository.setStatusByURI(articleId, 'reviewed');
        mailService.sendMailToAllEditors("Scientific articles - article reviewed", `Article "${select("/ns:title//text()", articleNode)}" has been reviewed by all reviewers.`);
    }
}

module.exports.assignReviewers = async (articleId, reviewers) => {
    let version = await articleRepository.getLastVersion(articleId);

    // check article status
    let status = await articleRepository.getStatusOf(articleId, version);
    if (status !== 'toBeReviewed') {
        let error = new Error("Article already has reviewers.")
        error.status = 400;
        throw error;
    }
    let articleURI = `article${articleId}/v${version}`
    
    let correspondingEmail = await articleRepository.getCorrespondingAuthor(articleId, version);
    for(let email of reviewers) {
        let exists = userRepository.existsByEmail(email);
        if (!exists) {
            let error = new Error(`Reviewer with email ${email} does not exists.`)
            error.status = 400;
            throw error;
        }
        // check if reviewer is author
        if (email == correspondingEmail) {
            let error = new Error("Reviewer cannot be author of article.");
            error.status = 400;
            throw error;
        }
    }

    // assign article to reviewers
    for(let email of reviewers) {
        await reviewsRepository.addArticleToReviewer(email, `article${articleId}`);

        // get role of reviewer and change if needed
        let role = await userRepository.getUserRole(email);
        if (role === "AUTHOR") {
            await userRepository.setUserRole(email, "REVIEWER");
        }
    
    }
    // set article status to inReviewProcess
    articleRepository.setStatus(articleId, version, 'inReviewProcess');
}

module.exports.saveXML = async (xml) => {
    var dom = new DOMParser().parseFromString(xml, 'text/xml');
    return reviewsRepository.saveXML(xml);
}

module.exports.readXML = async (reviewId) => {
    return reviewsRepository.readXML(reviewId);
}

module.exports.getReviewsForArticle = async(articleId, user) => {
    let version = await articleRepository.getLastVersion(articleId);
    let correspondingAuthorEmail = await articleRepository.getCorrespondingAuthor(articleId, version);
    let status = await articleRepository.getStatusOf(articleId, version);
    let access = checkArticleAccess(articleId, user, status, correspondingAuthorEmail)
    if (status == 'inReviewProcess' || access !== 'full') {
        let error = new Error('Unauthorized')
        error.status = 403;
        throw error;
    }
    return await reviewsRepository.getReviewsForArticle(articleId, version);
}

checkArticleAccess = (articleId, user, status, correspondingAuthorEmail) => {
    if (status === "accepted") {
        return 'full';
    } else {
        if (correspondingAuthorEmail === user.email) {
            return 'full';
        } 
        if (user.role === authorizationService.roles.editor) {
            if (user.toReview.includes(`article${articleId}`)) {
                return 'no-authors';
            }
            return 'full';
        }
        if (user.role === authorizationService.roles.reviewer && status === 'inReviewProcess') {
            if (user.toReview.includes(`article${articleId}`)) {
                return 'no-authors';
            }
        }
        return 'denied';
    }
}

module.exports.articlesToListItemHtml = async (articles) => {
    let xsltString = fs.readFileSync('./xsl/article-list-item-no-authors.xsl', 'utf8');

    return {
        htmls: await Promise.all(articles.map(async (articleXmlStringAndId) => {
            let articleHtmlString = await xsltService.transform(articleXmlStringAndId.xmlString, xsltString);
            return {
                html: articleHtmlString,
                id: articleXmlStringAndId.id
            };

        }))
    };
}