module.exports.query = `
    xquery version "3.1";
    declare namespace ns1 = "https://github.com/XML-tim17/ScientificArticles";
    for $article in collection("/db/scientificArticles/articles/")/ns1:article
    where $article/ns1:info//text() = "accepted"
        return <article>
                    {$article/ns1:title}
                    {$article/ns1:abstract}
                    {$article/ns1:info}       
                </article>
    `;