#include "impl_internal.h"

#include <assert.h>
#include <string.h>
#include <stdlib.h>

/*
 */
static Empathy_Result impl_instanceDestroy(Empathy_Instance this)
{
	assert(this);

	Impl_Instance *ptr = (Impl_Instance *)this;

	free(ptr);
	return EMPATHY_SUCCESS;
}

/*
 */
static Empathy_InstanceTable instance_vtbl =
{
	impl_instanceDestroy,
};

/*
 */
Empathy_Result impl_createInstance(const Empathy_InstanceDesc *desc, Empathy_Instance *instance)
{
	assert(desc);
	assert(instance);

	EMPATHY_UNUSED(desc);

	Impl_Instance *ptr = (Impl_Instance *)malloc(sizeof(Impl_Instance));
	assert(ptr);

	// vtable
	ptr->vtbl = &instance_vtbl;

	// data

	// pools

	*instance = (Empathy_Instance)ptr;
	return EMPATHY_SUCCESS;
}
